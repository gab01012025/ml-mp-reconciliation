/**
 * Rate Limiter
 * Token bucket algorithm for rate limiting API calls
 */

import { createLogger } from '../../config/logger.js';

const logger = createLogger('rate-limiter');

export interface RateLimiterOptions {
  name: string;
  maxTokens: number;           // Maximum tokens in bucket
  refillRate: number;          // Tokens added per interval
  refillIntervalMs: number;    // Interval for adding tokens
}

export interface RateLimiterStats {
  name: string;
  currentTokens: number;
  maxTokens: number;
  requestsAllowed: number;
  requestsDenied: number;
  lastRefill: Date;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: Date;
  private requestsAllowed = 0;
  private requestsDenied = 0;

  private readonly name: string;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly refillIntervalMs: number;

  constructor(options: RateLimiterOptions) {
    this.name = options.name;
    this.maxTokens = options.maxTokens;
    this.refillRate = options.refillRate;
    this.refillIntervalMs = options.refillIntervalMs;
    this.tokens = options.maxTokens;
    this.lastRefill = new Date();
  }

  /**
   * Try to acquire a token (returns true if allowed)
   */
  tryAcquire(tokens = 1): boolean {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      this.requestsAllowed++;
      return true;
    }

    this.requestsDenied++;
    logger.warn(
      {
        rateLimiter: this.name,
        currentTokens: this.tokens,
        requested: tokens,
      },
      'Rate limit exceeded'
    );
    return false;
  }

  /**
   * Acquire a token, waiting if necessary
   */
  async acquire(tokens = 1, maxWaitMs = 30000): Promise<void> {
    const startTime = Date.now();

    while (!this.tryAcquire(tokens)) {
      const elapsed = Date.now() - startTime;

      if (elapsed >= maxWaitMs) {
        throw new RateLimitExceededError(
          `Rate limit exceeded for ${this.name}. Could not acquire ${tokens} tokens within ${maxWaitMs}ms`
        );
      }

      // Wait for next refill
      const waitTime = Math.min(this.refillIntervalMs, maxWaitMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Refill tokens based on time elapsed
   */
  private refill(): void {
    const now = new Date();
    const elapsed = now.getTime() - this.lastRefill.getTime();
    const intervals = Math.floor(elapsed / this.refillIntervalMs);

    if (intervals > 0) {
      const tokensToAdd = intervals * this.refillRate;
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = new Date(this.lastRefill.getTime() + intervals * this.refillIntervalMs);
    }
  }

  /**
   * Get rate limiter stats
   */
  getStats(): RateLimiterStats {
    this.refill();

    return {
      name: this.name,
      currentTokens: this.tokens,
      maxTokens: this.maxTokens,
      requestsAllowed: this.requestsAllowed,
      requestsDenied: this.requestsDenied,
      lastRefill: this.lastRefill,
    };
  }

  /**
   * Reset rate limiter to full capacity
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = new Date();
    this.requestsAllowed = 0;
    this.requestsDenied = 0;
  }

  /**
   * Get time until next token is available (in ms)
   */
  getTimeUntilNextToken(): number {
    this.refill();

    if (this.tokens >= 1) {
      return 0;
    }

    const timeSinceLastRefill = Date.now() - this.lastRefill.getTime();
    const timeUntilNextRefill = this.refillIntervalMs - timeSinceLastRefill;

    return Math.max(0, timeUntilNextRefill);
  }
}

/**
 * Error thrown when rate limit is exceeded
 */
export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Preconfigured rate limiters for ML and MP APIs
 */
export const rateLimiters = {
  // Mercado Libre: 10,000 requests per minute for Apps
  mercadoLibre: new RateLimiter({
    name: 'mercado-libre',
    maxTokens: 100,        // Burst capacity
    refillRate: 10,        // ~166 per second = 10k per minute
    refillIntervalMs: 100,
  }),

  // Mercado Pago: More conservative limits
  mercadoPago: new RateLimiter({
    name: 'mercado-pago',
    maxTokens: 50,
    refillRate: 5,
    refillIntervalMs: 100,
  }),
};

/**
 * Rate limiter registry for managing multiple limiters
 */
class RateLimiterRegistry {
  private limiters = new Map<string, RateLimiter>();

  constructor() {
    // Register default limiters
    this.limiters.set('mercado-libre', rateLimiters.mercadoLibre);
    this.limiters.set('mercado-pago', rateLimiters.mercadoPago);
  }

  get(name: string, options?: Omit<RateLimiterOptions, 'name'>): RateLimiter {
    let limiter = this.limiters.get(name);

    if (!limiter && options) {
      limiter = new RateLimiter({ name, ...options });
      this.limiters.set(name, limiter);
    }

    if (!limiter) {
      throw new Error(`Rate limiter ${name} not found`);
    }

    return limiter;
  }

  getAll(): Map<string, RateLimiter> {
    return this.limiters;
  }

  getAllStats(): RateLimiterStats[] {
    return Array.from(this.limiters.values()).map((l) => l.getStats());
  }

  resetAll(): void {
    this.limiters.forEach((l) => l.reset());
  }
}

export const rateLimiterRegistry = new RateLimiterRegistry();
