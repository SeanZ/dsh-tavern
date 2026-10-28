// Third-party providers may ignore cancellation. Bound the caller's wait while
// still observing late rejections; the signal is also forwarded to the provider.
export function awaitNetwork(work, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(work).then(value => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}
