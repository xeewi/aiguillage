// Classic script loaded in <head>: pins a stored theme before the first paint (no flash, also in Electron where
// the window shows on its first frame). 'system' = no attribute, the CSS light-dark() tokens follow the OS.
{
  const theme = localStorage.getItem('aig.theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
}
