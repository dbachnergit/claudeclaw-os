import { describe, it, expect, vi } from 'vitest';
import { promoteToIssue } from '../promote';

describe('promoteToIssue', () => {
  it('invokes gh issue create with title, body, labels and returns the issue URL', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/dbachnergit/PatientScribe/issues/42\n',
      stderr: '',
      code: 0,
    });
    const url = await promoteToIssue({
      title: 'Crash on save',
      body: 'Reproduces every time.',
      labels: ['source:testflight', 'type:bug'],
      repo: 'dbachnergit/PatientScribe',
      exec,
    });
    expect(url).toBe('https://github.com/dbachnergit/PatientScribe/issues/42');
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--repo', 'dbachnergit/PatientScribe', '--title', 'Crash on save', '--body', 'Reproduces every time.', '--label', 'source:testflight', '--label', 'type:bug']
    );
  });

  it('omits --label args when labels is empty', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/x/y/issues/1\n',
      stderr: '',
      code: 0,
    });
    await promoteToIssue({ title: 't', body: 'b', labels: [], repo: 'x/y', exec });
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--repo', 'x/y', '--title', 't', '--body', 'b']
    );
  });

  it('throws when gh exits non-zero, including stderr in the message', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'auth failed', code: 1 });
    await expect(promoteToIssue({
      title: 't', body: 'b', labels: [], repo: 'x/y', exec,
    })).rejects.toThrow(/gh issue create failed: auth failed/);
  });

  it('trims trailing whitespace and newlines from the returned URL', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '  https://github.com/x/y/issues/7  \n\n',
      stderr: '',
      code: 0,
    });
    const url = await promoteToIssue({ title: 't', body: 'b', labels: [], repo: 'x/y', exec });
    expect(url).toBe('https://github.com/x/y/issues/7');
  });
});
