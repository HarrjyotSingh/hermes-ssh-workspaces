export function installDesktopStyles(css) {
  if (document.querySelector('style[data-hermes-editor-desktop]')) return () => {}
  const style = document.createElement('style')
  style.dataset.hermesEditorDesktop = ''
  style.textContent = css
  document.head.append(style)
  return () => style.remove()
}
