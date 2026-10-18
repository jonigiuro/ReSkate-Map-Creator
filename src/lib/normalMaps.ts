/** AmbientCG packs mark DirectX normals with "dx". OpenGL names stay as they are. */
export function isDirectXNormal(url: string | undefined) {
  if (!url) return false
  const name = decodeURIComponent(url.split(/[?#]/)[0]).toLowerCase()
  if (name.includes('opengl') || name.includes('normalogl') || name.includes('normalgl')) return false
  const tokens = name.split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.includes('gl')) return false
  return tokens.includes('dx') || tokens.includes('normaldx') || tokens.some((token) => token.endsWith('dx'))
}
