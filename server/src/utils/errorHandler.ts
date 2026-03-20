/**
 * Global Error Handling Module
 * 
 * Custom error classes and global error middleware for Express.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger.js';

// Determine if we're in development mode
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Custom Application Error Class
 * Extends built-in Error with statusCode and operational flag
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly status: string;
  public readonly isOperational: boolean;
  public readonly code?: string;
  public errors?: Record<string, string[]>;

  constructor(
    message: string,
    statusCode: number = 500,
    code?: string
  ) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Not Found Error (404)
 */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * Bad Request Error (400)
 */
export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

/**
 * Unauthorized Error (401)
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * Forbidden Error (403)
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * Conflict Error (409)
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * Validation Error (422) - specifically for Zod validation
 */
export class ValidationError extends AppError {
  public readonly errors: Record<string, string[]>;

  constructor(message: string = 'Validation failed', errors: Record<string, string[]> = {}) {
    super(message, 422, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}

/**
 * Async Handler Wrapper
 * Catches errors from async route handlers and passes to next()
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Global Error Middleware
 * Handles all errors in one place and sends appropriate response
 */
export const globalErrorHandler = (
  err: Error | AppError | ZodError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  let statusCode = 500;
  let message = 'Internal server error';
  let errors: Record<string, string[]> | undefined;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    statusCode = 422;
    message = 'Validation failed';
    errors = err.errors.reduce((acc, curr) => {
      const path = curr.path.join('.');
      if (!acc[path]) {
        acc[path] = [];
      }
      acc[path].push(curr.message);
      return acc;
    }, {} as Record<string, string[]>);
    
    logger.warn({
      message: 'Validation error',
      path: req.path,
      method: req.method,
      errors,
    });

    return res.status(statusCode).json({
      status: 'fail',
      message,
      errors,
    });
  }

  // Handle operational errors (AppError)
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    errors = err.errors;

    logger.warn({
      message: err.message,
      code: err.code,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    });
  } else {
    // Handle unknown/untrusted errors
    logger.error({
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });
  }

  // Send response based on environment
  const response: Record<string, unknown> = {
    status: statusCode >= 400 && statusCode < 500 ? 'fail' : 'error',
    message,
  };

  if (errors) {
    response.errors = errors;
  }

  // Include stack trace only in development
  if (isDevelopment && err instanceof Error) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

/**
 * Not Found Middleware
 * Catches undefined routes
 */
export const notFoundHandler = (req: Request, res: Response, _next: NextFunction) => {
  const error = new NotFoundError(`Route ${req.originalUrl} not found`);
  globalErrorHandler(error, req, res, _next);
};

export default {
  AppError,
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  asyncHandler,
  globalErrorHandler,
  notFoundHandler,
};
