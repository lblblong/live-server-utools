export function isNil(val: any) {
  return val === null || val === undefined
}

export function isNotNil(val: any) {
  return !isNil(val)
}

/**
 * 把本地绝对路径转成可交给 `utools.shellOpenExternal` 的 file:// URL。
 *
 * 旧实现直接拼 `'file://' + dir`：Windows 反斜杠、空格和中文都不会被处理，部分系统上会被
 * 当成不存在的 URL（打开目录按钮点了没反应）。这里统一：
 * - 反斜杠转正斜杠；
 * - Windows 盘符路径加 `file:///` 前缀（C:\a -> file:///C:/a）；
 * - UNC 路径（\\server\share）保留 `file://` + 双斜杠形式；
 * - 最后 encodeURI 处理空格/中文（保留 `:` 与 `/`）。
 */
export function toFileUrl(dir: string) {
  const normalized = dir.replace(/\\/g, '/')
  if (normalized.startsWith('//')) return encodeURI('file:' + normalized)
  return encodeURI('file:///' + normalized.replace(/^\/+/, ''))
}
