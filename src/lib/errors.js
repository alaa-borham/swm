'use strict';

class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, status = 400, details) => { throw new AppError(code, message, status, details); };
const notFound = (what) => fail('NOT_FOUND', `${what} غير موجود`, 404);
const forbidden = (message = 'ليست لديك صلاحية لهذه العملية') => fail('FORBIDDEN', message, 403);

module.exports = { AppError, fail, notFound, forbidden };
