export type PageInfo = {page:number;pageSize:number;total:number;pages:number};
export function Pagination({info,onChange,disabled=false}:{info:PageInfo;onChange:(page:number)=>void;disabled?:boolean}) {
  return <nav className="pagination" aria-label="列表分页" aria-busy={disabled}>
    <span role="status">共 {info.total} 条 · 第 {info.page} / {info.pages} 页 · 每页 {info.pageSize} 条</span>
    <div><button disabled={disabled || info.page<=1} onClick={()=>onChange(1)}>首页</button>
    <button disabled={disabled || info.page<=1} onClick={()=>onChange(info.page-1)}>上一页</button>
    <button disabled={disabled || info.page>=info.pages} onClick={()=>onChange(info.page+1)}>下一页</button>
    <button disabled={disabled || info.page>=info.pages} onClick={()=>onChange(info.pages)}>末页</button></div>
  </nav>;
}
