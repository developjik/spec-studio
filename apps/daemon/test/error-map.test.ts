import { describe, expect, it } from 'vitest';
import { DomainError } from '@spec-studio/core';
import { toHttpError } from '../src/server';

/**
 * W3 선행 Minor-3: the sqlite safety net must classify by `errcode`, not by
 * shape. A constraint (19, or an extended 19|(ext<<8)) is a rejected input —
 * 400. Everything else node:sqlite can throw — BUSY(5) while another process
 * holds the file, IOERR(10), CORRUPT(11), FULL(13), READONLY(8), NOMEM(7) —
 * is an unhealthy server and answers 500, never a disguised 400.
 *
 * And the hiding policy (관리자 W3 배정): a run that belongs to another
 * project is indistinguishable from a run that does not exist — the same
 * 404 run_not_found body the read routes already answer, so no client can
 * probe run ids across projects.
 */

/** node:sqlite stamps plain Errors with errcode/errstr — no class to build. */
function sqliteError(errcode: number): Error & { errcode: number; errstr: string } {
  const error = new Error(`sqlite says no (${errcode})`) as Error & { errcode: number; errstr: string };
  error.errcode = errcode;
  error.errstr = ` SQLITE_${errcode} `;
  return error;
}

describe('toHttpError — sqlite errcode classification (Minor-3)', () => {
  it('a constraint (19) is a rejected input: 400 invalid_input', () => {
    const failure = toHttpError(sqliteError(19));
    expect(failure.status).toBe(400);
    expect(failure.code).toBe('invalid_input');
  });

  it('an extended constraint (275 = 19|(1<<8), CHECK) is still 400', () => {
    const failure = toHttpError(sqliteError(275));
    expect(failure.status).toBe(400);
    expect(failure.code).toBe('invalid_input');
  });

  it('SQLITE_BUSY (5) is an unhealthy server: 500, never a disguised 400', () => {
    const failure = toHttpError(sqliteError(5));
    expect(failure.status).toBe(500);
    expect(failure.code).toBe('internal_error');
  });

  it('SQLITE_IOERR (10) is an unhealthy server: 500', () => {
    const failure = toHttpError(sqliteError(10));
    expect(failure.status).toBe(500);
    expect(failure.code).toBe('internal_error');
  });

  it('a plain Error with no errcode stays 500', () => {
    const failure = toHttpError(new Error('그냥 붕괴'));
    expect(failure.status).toBe(500);
  });
});

describe('toHttpError — cross-project hiding (읽기 경로 404 은닉 통일)', () => {
  it('run_scope answers the same 404 run_not_found as a missing run', () => {
    const failure = toHttpError(new DomainError('run_scope', '다른 프로젝트의 런입니다'));
    expect(failure.status).toBe(404);
    expect(failure.code).toBe('run_not_found');
    expect(failure.message).toBe('그런 런이 없습니다.');
  });

  it('run_missing keeps its 404', () => {
    const failure = toHttpError(new DomainError('run_missing', '그런 런이 없습니다'));
    expect(failure.status).toBe(404);
    expect(failure.code).toBe('run_missing');
  });
});
