import { checkNodeVersion } from './util/Validator'
import { loadObserverConfig, resolveObserverSourceSelection } from './runtime/observer/ObserverConfig'
import { ObserverRuntime } from './runtime/observer/ObserverRuntime'

async function bootstrap(): Promise<void> {
    checkNodeVersion()

    let runtime: ObserverRuntime | null = null

    try {
        const config = loadObserverConfig()
        const sourceSelection = resolveObserverSourceSelection(config, config.configDir, process.argv)
        console.log(
            `[OBSERVER] Mode: ${sourceSelection.environmentMode.toUpperCase()} | Sumber Akun: ${sourceSelection.sourceFile}`
        )

        runtime = new ObserverRuntime({
            config,
            sourceSelection
        })

        const handleShutdown = async (signal: string, exitCode: number) => {
            if (!runtime) process.exit(exitCode)
            console.log(`\n[OBSERVER] Received ${signal}, performing graceful shutdown...`)
            try {
                await runtime.stop(signal)
            } catch (err: any) {
                console.error(`[OBSERVER] Error during graceful shutdown: ${err.message}`)
            } finally {
                process.exit(exitCode)
            }
        }

        process.on('SIGINT', () => void handleShutdown('SIGINT', 130))
        process.on('SIGTERM', () => void handleShutdown('SIGTERM', 143))

        process.on('uncaughtException', async error => {
            console.error('[OBSERVER] Uncaught Exception:', error)
            if (runtime) {
                try {
                    await runtime.stop('uncaughtException')
                } catch {}
            }
            process.exit(1)
        })

        process.on('unhandledRejection', async reason => {
            console.error('[OBSERVER] Unhandled Rejection:', reason)
            if (runtime) {
                try {
                    await runtime.stop('unhandledRejection')
                } catch {}
            }
            process.exit(1)
        })

        await runtime.start()
        if (runtime.getState() === 'degraded') {
            console.log(
                '[OBSERVER] Runtime active in DEGRADED mode (periksa dashboard untuk petunjuk perbaikan konfigurasi).'
            )
        } else {
            console.log('[OBSERVER] Runtime active. Press Ctrl+C to stop.')
        }
    } catch (err: any) {
        console.error(`[OBSERVER-FATAL] Startup failed: ${err.message}`)
        if (runtime) {
            try {
                await runtime.stop('startup-failure')
            } catch {}
        }
        process.exit(1)
    }
}

void bootstrap()
