import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { createAppModule } from './app.module.js'

// forceCloseConnections: open SSE streams would otherwise keep app.close() waiting.
const app = await NestFactory.create(createAppModule(), { forceCloseConnections: true })
app.enableShutdownHooks() // closes the runtime (releasing its sessions) on SIGTERM
const port = Number(process.env.PORT ?? 3000)
await app.listen(port)
console.log(`listening on http://localhost:${port}`)
