import { describe, expect, it } from 'vitest';
import { claudeExecutable, commandOf } from '../src/winbin.js';

const NPM_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';

describe('claude on Windows', () => {
  const io = (files: Record<string, string>) => ({ platform: 'win32' as const, read: (p: string) => { if (p in files) return files[p]!; throw new Error('ENOENT'); }, isFile: (p: string) => p in files });

  it('runs the program an npm claude.cmd points to, not the batch file', () => {
    const bin = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
    const cli = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    expect(claudeExecutable(bin, io({ [bin]: NPM_SHIM, [cli]: '' }))).toBe(cli);
    const exe = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const exeShim = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    expect(claudeExecutable(bin, io({ [bin]: exeShim, [exe]: '' }))).toBe(exe);
  });

  it('keeps the path when it is no shim, the target is missing or lies outside the shim folder', () => {
    const bin = 'C:\\npm\\claude.cmd';
    expect(claudeExecutable(bin, io({ [bin]: NPM_SHIM }))).toBe(bin);
    expect(claudeExecutable(bin, io({ [bin]: '"%dp0%\\..\\evil\\cli.js" %*', 'C:\\evil\\cli.js': '' }))).toBe(bin);
    expect(claudeExecutable('C:\\Users\\u\\.local\\bin\\claude.exe', io({}))).toBe('C:\\Users\\u\\.local\\bin\\claude.exe');
    expect(claudeExecutable('/usr/local/bin/claude.cmd', { platform: 'darwin' })).toBe('/usr/local/bin/claude.cmd');
  });

  it('starts a .js CLI on this Node and anything else directly', () => {
    expect(commandOf('C:\\x\\cli.js')).toEqual({ cmd: process.execPath, args: ['C:\\x\\cli.js'] });
    expect(commandOf('/usr/local/bin/claude')).toEqual({ cmd: '/usr/local/bin/claude', args: [] });
  });
});
