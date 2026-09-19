import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Screen from './Screen'
import './styles.css'

/**
 * Two surfaces, one bundle: the phone in someones hand, and the projector.
 * `/screen` is the one that goes on the wall.
 */
const isScreen = window.location.pathname.replace(/\/+$/, '') === '/screen'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isScreen ? <Screen /> : <App />}</StrictMode>,
)
