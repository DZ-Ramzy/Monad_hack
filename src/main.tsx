import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Screen from './Screen'
import './styles.css'

/** WebGL, so it rides in on its own chunk rather than in the first paint. */
const SiteBackground = lazy(() => import('./components/SiteBackground'))

/**
 * Two surfaces, one bundle: the phone in someones hand, and the projector.
 * `/screen` is the one that goes on the wall.
 */
const isScreen = window.location.pathname.replace(/\/+$/, '') === '/screen'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <SiteBackground />
    </Suspense>
    {isScreen ? <Screen /> : <App />}
  </StrictMode>,
)
