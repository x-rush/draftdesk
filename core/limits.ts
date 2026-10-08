// 全局长度限制常量：散落魔法数字已出过三次 bug（ids≤500 卡长 URL、evidenceRefs≤100 卡论据、unconsume 500 没跟上）。
// 新代码一律引用此处，不要写死数字。
export const LIMITS = {
  /** 热点/证据身份键最大长度（URL 归一化后可达 2048） */
  idMax: 2048,
  /** 批量操作（consume ids / clusterIds 展开）单次上限 */
  batchMax: 1000,
  /** 大纲 evidenceRefs 单项上限（与 idMax 对齐） */
  refMax: 2048,
  /** 草稿正文最大长度 */
  draftMax: 100000,
  /** HTTP 请求体最大长度 */
  bodyMax: 1000000,
  /** 连接名称最大长度 */
  nameMax: 80,
} as const;
