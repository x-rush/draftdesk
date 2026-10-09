# DraftDesk 数据库运维手册

存储：`data/draftdesk.sqlite`（SQLite，WAL 模式），`app` 与 `worker` 容器以 bind mount（`./data:/app/data`）同时使用。

## Schema 心智模型（先读这个再写诊断脚本）

底层只有 **5 张表**：`documents(collection, id, body)` + `submissions` / `schedules` / `budgets` / `locks`。

**所有业务集合（connections、clusters、outlines、artifacts、evidence、discovery、jobs、config、meta…）都是 `documents` 里的行，不是独立的表。**
诊断时查数据用：

```sql
SELECT collection, count(*) FROM documents GROUP BY collection;
SELECT count(*) FROM documents WHERE collection='connections';
```

而不是 `SELECT * FROM connections`——那会报 no such table，是正常现象，不是损坏。

## 🔴 铁律：宿主机进程不得打开活库

容器运行期间，**宿主机任何进程都不得以 SQLite 方式打开 `data/draftdesk.sqlite`**（读写和可写打开都禁止；`readFileSync` 裸字节读不取锁、可用）。

原因：容器经 Docker 文件共享层（grpc-fuse）访问该文件，宿主机写走 Windows 文件系统——两条视图并发写会发生页级损坏（2026-10-01 事故）与页缓存失谐（2026-10-09 事故）。

- 宿主机要操作 DB：先 `docker compose stop app worker`，操作完再 `up -d`
- 测试一律 `npm test`（见下）
- 只读检查走容器：`docker compose exec worker sh -c "node -e '...'"`

## 🔴 测试必须经 `npm test`（scripts/run-tests.mjs）

`Store` 的兜底数据目录是 `cwd/data` = 活库。历史上 16 个测试文件未设 `DRAFTDESK_DATA_DIR` 就实例化 store——宿主机直跑 `tsx --test` 时它们会打开活库。运行器为整个测试进程树注入临时目录；`tests/zz-isolation-guard.test.ts` 在绕过运行器时会直接红掉。

## 🔴 容器重建规范：先 stop 再 build

`docker compose up -d --build app` 会**强杀**旧容器（SIGKILL，无机会做 WAL 收尾），新挂载实例可能对 `draftdesk.sqlite-wal` / `-shm` 文件名持有脏目录缓存——创建报 ENOENT，health 500 `unable to open database file`。2026-10-10 一天内复发两次。

**触发规律**：强杀持有 WAL 连接的容器 + 同名文件句柄未释放 → grpc-fuse 目录缓存残留旧条目 → 新容器对该确切文件名创建失败（同目录建其他名字正常，宿主机侧文件完好）。

**预防（标准流程）**：
```
docker compose stop app      # SIGTERM，进程干净退出，WAL 正常 checkpoint 收尾
docker compose up -d --build app
```

**已中招的恢复**：`docker compose stop` → `wsl --terminate docker-desktop`（清文件共享层缓存，数据无损）→ `docker compose up -d` → health + `pragma quick_check` + 计数核对。

## 事故记录

### 2026-10-01 · 宿主机写活库 → 页级损坏

宿主机在容器运行时以 better-sqlite3 打开活库，页级损坏，经 `.recover` 修复。备份存 `../data-incident-backup-20261001/`（含 `after-host-repair.sqlite`）。

### 2026-10-09 · 测试双写 → 挂载页缓存失谐（零数据丢失）

- **现象**：重建 app 容器后 health 500。第一层：容器内创建 `draftdesk.sqlite-wal` 报 ENOENT（该确切文件名被 Docker 文件共享层的脏目录缓存挡住，同目录建其他名字正常）；绕过后第二层：`pragma quick_check` 稳定报 `Tree 2 page 14: unable to get the page, error 522`（SHORT_READ）。
- **误判警示**：诊断脚本曾按「每个 collection 一张表」的模型查询，报「connections 表消失」「库被全新初始化」——实际是 schema 心智模型错误，数据始终完好（documents 4044 行俱在）。
- **定性**：宿主机侧原始字节读显示 page 14 是完好表叶页（0x0D 页头、3751/4096 非零）——文件无损，是 **grpc-fuse 页缓存失谐导致容器读该页短路**。诱因是测试套件（无隔离）当天在宿主机打开过活库，WAL 检查点穿过 Windows 视图与容器挂载并发。
- **处置**：`docker compose stop` → `wsl --terminate docker-desktop`（文件共享层缓存随发行版终结清空，数据无损）→ `docker compose up -d` → health ok、quick_check ok、计数核对一致。
- **快照**：`../data-incident-backup-20261001/mount-cache-incident-20261009/pre-restart-snapshot.sqlite`（重启前宿主机裸字节副本）。
- **防再发**：`npm test` 强制隔离 + 守卫测试 + 本文档。

## 恢复工具箱

- 一致性快照（容器侧）：`node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/draftdesk.sqlite',{readOnly:true});db.exec(\"VACUUM INTO '/app/data/snap.sqlite'\")"`
- 只读完整性：`pragma quick_check`（读专用连接）
- 裸字节快照（宿主机、不取锁）：`fs.copyFileSync('data/draftdesk.sqlite', ...)`——容器运行时唯一安全的宿主机操作
- 救援已删除但被进程握住的旧文件：容器内 `ls -la /proc/1/fd` 找句柄，`cat /proc/<pid>/fd/<n> > /tmp/...`（注意 `/proc` 句柄指向 inode，与路径解耦）
