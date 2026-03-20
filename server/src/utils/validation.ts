/**
 * Zod Validation Middleware
 * 
 * Reusable validation middleware using Zod schemas.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, AnyZodObject, ZodError, ZodIssue } from 'zod';
import { ValidationError } from '../utils/errorHandler.js';

/**
 * Validate request body against a Zod schema
 */
export const validateBody = (schema: ZodSchema) => {
  return validate(schema, 'body');
};

/**
 * Validate request query parameters against a Zod schema
 */
export const validateQuery = (schema: ZodSchema) => {
  return validate(schema, 'query');
};

/**
 * Validate request URL parameters against a Zod schema
 */
export const validateParams = (schema: ZodSchema) => {
  return validate(schema, 'params');
};

/**
 * Validate multiple request parts at once
 */
export const validate = (schema: ZodSchema, source: 'body' | 'query' | 'params') => {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const data = req[source];
      const validated = schema.parse(data);
      
      // Replace the data with validated (and potentially transformed) data
      req[source] = validated;
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Format Zod errors into a more readable structure
        const errors = formatZodErrors(error);
        next(new ValidationError('Validation failed', errors));
      } else {
        next(error);
      }
    }
  };
};

/**
 * Format Zod errors into a structured object
 */
function formatZodErrors(zodError: ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  for (const issue of zodError.errors) {
    const path = issue.path.join('.');
    const message = formatZodIssueMessage(issue);

    if (!errors[path]) {
      errors[path] = [];
    }
    errors[path].push(message);
  }

  return errors;
}

/**
 * Format a single Zod issue into a user-friendly message
 */
function formatZodIssueMessage(issue: ZodIssue): string {
  const path = issue.path.join('.');
  
  switch (issue.code) {
    case 'invalid_type':
      return `Expected ${issue.expected}, got ${issue.received}`;
    case 'invalid_string':
      if (issue.validation === 'email') {
        return 'Invalid email format';
      }
      if (issue.validation === 'url') {
        return 'Invalid URL format';
      }
      return `Invalid string format`;
    case 'too_small':
      if ('type' in issue && issue.type === 'string') {
        return `Minimum length is ${issue.minimum} characters`;
      }
      if ('type' in issue && issue.type === 'number') {
        return `Minimum value is ${issue.minimum}`;
      }
      if ('type' in issue && issue.type === 'array') {
        return `Minimum ${issue.minimum} items required`;
      }
      return `Value is too small`;
    case 'too_big':
      if ('type' in issue && issue.type === 'string') {
        return `Maximum length is ${issue.maximum} characters`;
      }
      if ('type' in issue && issue.type === 'number') {
        return `Maximum value is ${issue.maximum}`;
      }
      if ('type' in issue && issue.type === 'array') {
        return `Maximum ${issue.maximum} items allowed`;
      }
      return `Value is too big`;
    case 'custom':
      return issue.message || `Invalid ${path}`;
    case 'invalid_enum_value':
      return `Value must be one of: ${issue.options.join(', ')}`;
    default:
      return issue.message || `Invalid ${path}`;
  }
}

/**
 * Create a partial validation (allows unknown fields)
 */
export const validatePartial = (schema: AnyZodObject) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const partialSchema = schema.partial();
      const data = req.body;
      const validated = partialSchema.parse(data);
      req.body = validated;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        next(new ValidationError('Validation failed', errors));
      } else {
        next(error);
      }
    }
  };
};

/**
 * Combine multiple validations
 */
export const validateAll = (...validations: ReturnType<typeof validateBody>[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    let index = 0;
    
    const runNext = (err?: any) => {
      if (err) {
        return next(err);
      }
      
      if (index >= validations.length) {
        return next();
      }
      
      const middleware = validations[index++];
      middleware(req, _res as Response, runNext as NextFunction);
    };
    
    runNext();
  };
};

export default {
  validateBody,
  validateQuery,
  validateParams,
  validate,
  validatePartial,
  validateAll,
};
