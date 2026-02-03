/**
 * Tests for retry, circuit breaker, and rate limiter utilities
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, CircuitState } from './circuit-breaker.js';
import { RateLimiter, RateLimitExceededError } from './rate-limiter.js';
import { createRetryable, isRetryableError, withRetry } from './retry.js';

describe('Retry Utility', () => {
  describe('isRetryableError', () => {
    it('should return true for network errors', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
      expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    });

    it('should return true for 5xx status codes', () => {
      const error = Object.assign(new Error('Server error'), { statusCode: 500 });
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for 429 rate limit', () => {
      const error = Object.assign(new Error('Rate limited'), { statusCode: 429 });
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for 4xx client errors', () => {
      const error = Object.assign(new Error('Not found'), { statusCode: 404 });
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await withRetry(fn, { maxAttempts: 3 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue('success');

      // Use very small delay for faster tests
      const result = await withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 20,
      });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max attempts', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        withRetry(fn, {
          maxAttempts: 2,
          initialDelayMs: 10,
          maxDelayMs: 20,
        })
      ).rejects.toThrow('ECONNREFUSED');

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry non-retryable errors', async () => {
      const error = Object.assign(new Error('Not found'), { statusCode: 404 });
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow('Not found');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('createRetryable', () => {
    it('should create a retryable wrapper', async () => {
      const originalFn = vi.fn().mockResolvedValue('result');
      const retryableFn = createRetryable(originalFn, { maxAttempts: 3 });

      const result = await retryableFn('arg1', 'arg2');

      expect(result).toBe('result');
      expect(originalFn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });
});

describe('Circuit Breaker', () => {
  describe('execute', () => {
    it('should allow requests when closed', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      const fn = vi.fn().mockResolvedValue('success');

      const result = await cb.execute(fn);

      expect(result).toBe('success');
      expect(cb.getStats().state).toBe(CircuitState.CLOSED);
    });

    it('should open after failure threshold', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 2 });
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // First failure
      await expect(cb.execute(fn)).rejects.toThrow('fail');
      expect(cb.getStats().state).toBe(CircuitState.CLOSED);

      // Second failure - should open
      await expect(cb.execute(fn)).rejects.toThrow('fail');
      expect(cb.getStats().state).toBe(CircuitState.OPEN);
    });

    it('should reject immediately when open', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        timeout: 30000,
      });
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      await expect(cb.execute(fn)).rejects.toThrow('fail');

      // Should reject immediately without calling fn
      await expect(cb.execute(fn)).rejects.toThrow(CircuitOpenError);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should transition to half-open after timeout', async () => {
      vi.useFakeTimers();

      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        timeout: 1000,
      });
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getStats().state).toBe(CircuitState.OPEN);

      // Advance time past timeout
      vi.advanceTimersByTime(1001);

      // Next request should go through (half-open)
      const result = await cb.execute(successFn);
      expect(result).toBe('success');

      vi.useRealTimers();
    });

    it('should close after success threshold in half-open', async () => {
      vi.useFakeTimers();

      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        successThreshold: 2,
        timeout: 1000,
      });

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      const successFn = vi.fn().mockResolvedValue('success');

      // Open the circuit
      await expect(cb.execute(failFn)).rejects.toThrow('fail');

      // Advance time
      vi.advanceTimersByTime(1001);

      // First success (half-open)
      await cb.execute(successFn);
      expect(cb.getStats().state).toBe(CircuitState.HALF_OPEN);

      // Second success - should close
      await cb.execute(successFn);
      expect(cb.getStats().state).toBe(CircuitState.CLOSED);

      vi.useRealTimers();
    });
  });

  describe('manual controls', () => {
    it('should allow manual trip', () => {
      const cb = new CircuitBreaker({ name: 'test' });

      cb.trip();

      expect(cb.getStats().state).toBe(CircuitState.OPEN);
    });

    it('should allow manual reset', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      await expect(cb.execute(fn)).rejects.toThrow('fail');
      expect(cb.getStats().state).toBe(CircuitState.OPEN);

      cb.reset();

      expect(cb.getStats().state).toBe(CircuitState.CLOSED);
    });
  });
});

describe('Rate Limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('tryAcquire', () => {
    it('should allow requests within limit', () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 10,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      for (let i = 0; i < 10; i++) {
        expect(rl.tryAcquire()).toBe(true);
      }
    });

    it('should deny requests when limit exceeded', () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 2,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      expect(rl.tryAcquire()).toBe(true);
      expect(rl.tryAcquire()).toBe(true);
      expect(rl.tryAcquire()).toBe(false);
    });

    it('should refill tokens over time', () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 2,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      // Exhaust tokens
      rl.tryAcquire();
      rl.tryAcquire();
      expect(rl.tryAcquire()).toBe(false);

      // Advance time to refill 1 token
      vi.advanceTimersByTime(1000);

      expect(rl.tryAcquire()).toBe(true);
      expect(rl.tryAcquire()).toBe(false);
    });

    it('should not exceed max tokens', () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 5,
        refillRate: 10,
        refillIntervalMs: 1000,
      });

      // Advance time to add many tokens
      vi.advanceTimersByTime(10000);

      // Should only have maxTokens
      const stats = rl.getStats();
      expect(stats.currentTokens).toBe(5);
    });
  });

  describe('acquire', () => {
    it('should wait for tokens', async () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 1,
        refillRate: 1,
        refillIntervalMs: 100,
      });

      // Exhaust tokens
      rl.tryAcquire();

      // Start acquire (will wait)
      const acquirePromise = rl.acquire(1, 1000);

      // Advance time
      vi.advanceTimersByTime(100);

      await acquirePromise;
      // Should complete without throwing
    });

    it('should throw after max wait time', async () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 1,
        refillRate: 1,
        refillIntervalMs: 10000, // Very slow refill
      });

      // Exhaust tokens
      rl.tryAcquire();

      // Try to acquire with short timeout
      const acquirePromise = rl.acquire(1, 100);

      // Advance time past timeout
      vi.advanceTimersByTime(200);

      await expect(acquirePromise).rejects.toThrow(RateLimitExceededError);
    });
  });

  describe('getStats', () => {
    it('should track allowed and denied requests', () => {
      const rl = new RateLimiter({
        name: 'test',
        maxTokens: 2,
        refillRate: 1,
        refillIntervalMs: 1000,
      });

      rl.tryAcquire(); // allowed
      rl.tryAcquire(); // allowed
      rl.tryAcquire(); // denied
      rl.tryAcquire(); // denied

      const stats = rl.getStats();
      expect(stats.requestsAllowed).toBe(2);
      expect(stats.requestsDenied).toBe(2);
    });
  });
});
