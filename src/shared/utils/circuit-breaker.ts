/**
 * Circuit Breaker
 * Prevents cascading failures by failing fast when a service is unavailable
 */

import { createLogger } from '../../config/logger.js';

const logger = createLogger('circuit-breaker');

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing fast, not allowing requests
  HALF_OPEN = 'HALF_OPEN', // Testing if service is back
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;       // Number of failures before opening
  successThreshold?: number;       // Successes in half-open to close
  timeout?: number;                // Time in ms before trying again (half-open)
  resetTimeout?: number;           // Time in ms to reset failure count
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private nextAttempt: Date | null = null;
  private totalCalls = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeout = options.timeout ?? 30000;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      if (this.nextAttempt && new Date() < this.nextAttempt) {
        throw new CircuitOpenError(
          `Circuit ${this.name} is open. Try again after ${this.nextAttempt.toISOString()}`
        );
      }
      // Time to try again
      this.transitionTo(CircuitState.HALF_OPEN);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful call
   */
  private onSuccess(): void {
    this.lastSuccess = new Date();
    this.totalSuccesses++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;

      if (this.successes >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    } else {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  /**
   * Handle failed call
   */
  private onFailure(): void {
    this.lastFailure = new Date();
    this.totalFailures++;
    this.failures++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open goes back to open
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failures >= this.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;

    if (oldState === newState) return;

    logger.info(
      { circuitName: this.name, from: oldState, to: newState },
      'Circuit breaker state change'
    );

    this.state = newState;

    switch (newState) {
      case CircuitState.OPEN:
        this.nextAttempt = new Date(Date.now() + this.timeout);
        this.successes = 0;
        break;

      case CircuitState.HALF_OPEN:
        this.successes = 0;
        break;

      case CircuitState.CLOSED:
        this.failures = 0;
        this.successes = 0;
        this.nextAttempt = null;
        break;
    }

    this.onStateChange?.(oldState, newState);
  }

  /**
   * Get circuit breaker stats
   */
  getStats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Force circuit to open state
   */
  trip(): void {
    this.transitionTo(CircuitState.OPEN);
  }

  /**
   * Force circuit to closed state
   */
  reset(): void {
    this.transitionTo(CircuitState.CLOSED);
  }

  /**
   * Check if circuit is allowing requests
   */
  isAllowing(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.HALF_OPEN) return true;
    if (this.state === CircuitState.OPEN && this.nextAttempt) {
      return new Date() >= this.nextAttempt;
    }
    return false;
  }
}

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Circuit breaker registry for managing multiple circuits
 */
class CircuitBreakerRegistry {
  private circuits = new Map<string, CircuitBreaker>();

  get(name: string, options?: Omit<CircuitBreakerOptions, 'name'>): CircuitBreaker {
    let circuit = this.circuits.get(name);

    if (!circuit) {
      circuit = new CircuitBreaker({ name, ...options });
      this.circuits.set(name, circuit);
    }

    return circuit;
  }

  getAll(): Map<string, CircuitBreaker> {
    return this.circuits;
  }

  getAllStats(): CircuitBreakerStats[] {
    return Array.from(this.circuits.values()).map((c) => c.getStats());
  }

  resetAll(): void {
    this.circuits.forEach((c) => c.reset());
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();
