import { Signal, ISignalAdapter } from '../../types/src';
import { Logger } from './logger.js';
/**
 * Logger Adapter - Converts signals to structured log messages
 *
 * Transforms signals from the SMRT framework into structured log entries.
 * Each signal type is mapped to an appropriate log level:
 * - start → debug
 * - step → debug
 * - end → info
 * - error → error
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger('info');
 * const adapter = new LoggerAdapter(logger);
 * signalBus.register(adapter);
 * ```
 */
export declare class LoggerAdapter implements ISignalAdapter {
    private logger;
    constructor(logger: Logger);
    /**
     * Handle a signal and log appropriately
     *
     * @param signal - Signal to log
     */
    handle(signal: Signal): Promise<void>;
}
//# sourceMappingURL=adapter.d.ts.map