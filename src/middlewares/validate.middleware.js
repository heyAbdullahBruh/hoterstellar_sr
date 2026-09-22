import { ZodError } from 'zod';
import { validationResult } from 'express-validator';
import { ValidationError } from '../errors/ValidationError.js';

/**
 * Extract field-level details from a Zod error.
 * Zod v4 uses `.issues` (v3 used `.errors`).
 * Support both for safety during migrations.
 */
const extractZodDetails = (error) => {
  const issues = error.issues || error.errors || [];

  return issues.map((issue) => ({
    field: Array.isArray(issue.path)
      ? issue.path.join('.')
      : String(issue.path || ''),
    message: issue.message,
    code: issue.code,
  }));
};

export const validateBody = (schema) => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          new ValidationError('Validation failed', extractZodDetails(error)),
        );
      } else {
        next(error);
      }
    }
  };
};

export const validateQuery = (schema) => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.query);
      req.query = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          new ValidationError(
            'Query validation failed',
            extractZodDetails(error),
          ),
        );
      } else {
        next(error);
      }
    }
  };
};

export const validateParams = (schema) => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.params);
      req.params = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          new ValidationError(
            'Params validation failed',
            extractZodDetails(error),
          ),
        );
      } else {
        next(error);
      }
    }
  };
};

export const runExpressValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const details = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));
    return next(new ValidationError('Validation failed', details));
  }
  next();
};
