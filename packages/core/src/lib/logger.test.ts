import { afterEach, describe, expect, it, vi } from 'vitest';

describe('logger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exposes standard and custom log methods', async () => {
    const logger = (await import('./logger')).default as any;

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.system).toBe('function');
  });

  it('suppresses debug and trace when LOG_LEVEL is INFO', async () => {
    const logger = (await import('./logger')).default;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    vi.stubEnv('LOG_LEVEL', 'INFO');
    logger.debug('hidden');
    logger.trace('hidden', { detail: true });
    logger.info('shown');
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('shown');

    vi.stubEnv('LOG_LEVEL', 'debug');
    logger.debug('shown');
    expect(debug).toHaveBeenCalledWith('shown');
  });

  it('logs every level when LOG_LEVEL is unset', async () => {
    const logger = (await import('./logger')).default;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    vi.stubEnv('LOG_LEVEL', '');
    logger.trace('shown');
    expect(debug).toHaveBeenCalledWith('shown');
  });
});
