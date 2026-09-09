import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './responsive.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Sprint P4.2 (PWA Foundation). Registro del service worker (public/sw.js
// -- ver ese archivo para la estrategia de cache exacta, NUNCA financiera).
// No hace reload automatico: cuando hay una version nueva "waiting",
// dispara un CustomEvent que src/App.jsx escucha para mostrar un banner
// "Hay una nueva version -- Actualizar" controlado por el usuario. Ver
// window.__moniApplyServiceWorkerUpdate, que App.jsx llama al click.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      function notifyUpdateAvailable(worker) {
        window.__moniApplyServiceWorkerUpdate = () => {
          worker.postMessage({ type: 'SKIP_WAITING' })
        }
        window.dispatchEvent(new CustomEvent('moni:sw-update-available'))
      }

      // Ya habia un SW controlando la pagina Y ya hay uno nuevo esperando
      // (por ejemplo, si el registro ocurre despues de un install previo).
      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyUpdateAvailable(registration.waiting)
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing
        if (!newWorker) return
        newWorker.addEventListener('statechange', () => {
          // "installed" + ya habia un controller = version nueva lista,
          // no la primera instalacion (esa no necesita banner de update).
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            notifyUpdateAvailable(newWorker)
          }
        })
      })
    }).catch(() => {
      // Registro de SW es progresivo: si falla (browser sin soporte,
      // contexto no seguro, etc.) la app sigue funcionando igual, sin PWA.
    })

    let reloadedOnce = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadedOnce) return
      reloadedOnce = true
      window.location.reload()
    })
  })
}
