export const fmt = (v?: string | null) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "尚未同步";
export const short = (v: string) =>
  v
    .replace("cann/", "")
    .replace("triton-inference-server-ge-backend", "triton-ge-backend");
export const replyLabel: Record<string, string> = {
  replied: "已回复",
  unreplied: "未回复",
  unknown: "无法确认",
};
export const params = () =>
  new URLSearchParams(location.hash.split("?")[1] || "");
export function go(values: Record<string, string> = {}, view = "issues") {
  location.hash = `/${view}?${new URLSearchParams(values)}`;
}
