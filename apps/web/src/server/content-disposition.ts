/** A `content-disposition` for a download named by a person. Header values must be
 *  Latin-1 and a quote ends the parameter, so `filename` carries a printable ASCII
 *  stand-in for old clients and `filename*` (RFC 5987) carries the real name. */
export const attachment = (filename: string): string => {
  // Round trip through UTF-8: a lone surrogate would make encodeURIComponent throw.
  const name = new TextDecoder().decode(new TextEncoder().encode(filename))
  const standIn = name.replace(/[^\x20-\x7e]|["\\%]/gu, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${standIn}"; filename*=UTF-8''${encoded}`
}
