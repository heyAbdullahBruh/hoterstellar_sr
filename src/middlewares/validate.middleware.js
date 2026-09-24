import { ZodError } from 'zod';
import { validationResult } from 'express-validator';
import { ValidationError } from '../errors/ValidationError.js';

/**
 * Extract field-level details from a Zod error.
 * Zod v4 uses `.issues` (v3 used `.errors`).
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

/**
 * Express 5 made req.query, req.params (and req.body in some cases)
 * getter-only. This helper mutates the object in place so we don't
 * trigger "Cannot set property X which has only a getter".
 */
const mutateInPlace = (target, source) => {
  if (
    !target ||
    typeof target !== 'object' ||
    !source ||
    typeof source !== 'object'
  ) {
    return;
  }

  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
};

export const validateBody = (schema) => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed; // body is still writable in Express 5
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
      mutateInPlace(req.query, parsed); // ✅ Express 5 safe
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
      mutateInPlace(req.params, parsed); // ✅ Express 5 safe
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
