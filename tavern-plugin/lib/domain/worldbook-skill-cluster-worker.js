import { parentPort, workerData } from 'node:worker_threads'
import { compileWorldbookSkillClusters } from './worldbook-skill-clustering.js'
try {
  parentPort.postMessage({ result: compileWorldbookSkillClusters(workerData.entries, workerData.options) })
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } })
}
