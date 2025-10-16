/**
 * Tests for CLI Argument Parsing
 */

import { describe, it, expect } from 'vitest';
import { parseCliArgs, type Command } from './parse-args';

describe('parseCliArgs', () => {
  const sampleCommands: Command[] = [
    {
      name: 'help',
      description: 'Show help',
    },
    {
      name: 'version',
      description: 'Show version',
    },
    {
      name: 'gnode create',
      description: 'Create a new gnode',
      args: ['name'],
      options: {
        template: {
          type: 'string',
          description: 'Template to use',
          default: 'town',
        },
        'output-dir': {
          type: 'string',
          description: 'Output directory',
        },
      },
    },
    {
      name: 'gnode list-templates',
      description: 'List available templates',
      aliases: ['gnode ls'],
    },
    {
      name: 'generate',
      description: 'Generate code',
      options: {
        verbose: {
          type: 'boolean',
          description: 'Verbose output',
          short: 'v',
        },
      },
    },
  ];

  describe('Node/script path removal', () => {
    it('removes /usr/bin/node and script.js', () => {
      const result = parseCliArgs(
        ['/usr/bin/node', 'script.js', 'help'],
        sampleCommands,
      );
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    it('removes node and script.js', () => {
      const result = parseCliArgs(['node', 'cli.js', 'help'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    it('removes ./cli.js', () => {
      const result = parseCliArgs(['./cli.js', 'help'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    it('does not remove "gnode" command (edge case)', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
    });

    it('handles direct command execution (no node prefix)', () => {
      const result = parseCliArgs(['help'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });
  });

  describe('Multi-word command matching', () => {
    it('matches two-word command "gnode create"', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
    });

    it('matches two-word command "gnode list-templates"', () => {
      const result = parseCliArgs(['gnode', 'list-templates'], sampleCommands);
      expect(result.command).toBe('gnode list-templates');
      expect(result.args).toEqual([]);
    });

    it('prefers longest match (2 words over 1 word)', () => {
      const result = parseCliArgs(['gnode', 'create', 'test'], sampleCommands);
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['test']);
    });
  });

  describe('Single-word command matching', () => {
    it('matches single-word command "help"', () => {
      const result = parseCliArgs(['help'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    it('matches single-word command "version"', () => {
      const result = parseCliArgs(['version'], sampleCommands);
      expect(result.command).toBe('version');
      expect(result.args).toEqual([]);
    });

    it('matches single-word command "generate"', () => {
      const result = parseCliArgs(['generate'], sampleCommands);
      expect(result.command).toBe('generate');
      expect(result.args).toEqual([]);
    });
  });

  describe('Command aliases', () => {
    it('matches alias "gnode ls" to "gnode list-templates"', () => {
      const result = parseCliArgs(['gnode', 'ls'], sampleCommands);
      expect(result.command).toBe('gnode ls');
      expect(result.args).toEqual([]);
    });
  });

  describe('Positional arguments', () => {
    it('extracts positional argument after command', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
    });

    it('extracts multiple positional arguments', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site', 'extra-arg'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site', 'extra-arg']);
    });
  });

  describe('Option parsing', () => {
    it('parses --template=town', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site', '--template=town'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
      expect(result.options.template).toBe('town');
    });

    it('parses --template town (space-separated)', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site', '--template', 'town'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
      expect(result.options.template).toBe('town');
    });

    it('parses boolean option --verbose', () => {
      const result = parseCliArgs(['generate', '--verbose'], sampleCommands);
      expect(result.command).toBe('generate');
      expect(result.options.verbose).toBe(true);
    });

    it('parses short option -v', () => {
      const result = parseCliArgs(['generate', '-v'], sampleCommands);
      expect(result.command).toBe('generate');
      expect(result.options.verbose).toBe(true);
    });

    it('applies default option values', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'my-site'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.options.template).toBe('town');
    });

    it('parses multiple options', () => {
      const result = parseCliArgs(
        [
          'gnode',
          'create',
          'my-site',
          '--template=custom',
          '--output-dir=./output',
        ],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
      expect(result.options.template).toBe('custom');
      expect(result.options['output-dir']).toBe('./output');
    });
  });

  describe('Global flags', () => {
    it('recognizes --help flag', () => {
      const result = parseCliArgs(['--help'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    it('recognizes -h flag', () => {
      const result = parseCliArgs(['-h'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    it('recognizes --version flag', () => {
      const result = parseCliArgs(['--version'], sampleCommands);
      expect(result.command).toBe('version');
      expect(result.args).toEqual([]);
    });

    it('recognizes -v flag', () => {
      const result = parseCliArgs(['-v'], sampleCommands);
      expect(result.command).toBe('version');
      expect(result.args).toEqual([]);
    });
  });

  describe('Unknown commands', () => {
    it('returns unknown command name', () => {
      const result = parseCliArgs(['unknown-cmd', 'arg1'], sampleCommands);
      expect(result.command).toBe('unknown-cmd');
      expect(result.args).toEqual(['arg1']);
      expect(result.options).toEqual({});
    });

    it('handles unknown command with options', () => {
      const result = parseCliArgs(['unknown', '--foo=bar'], sampleCommands);
      expect(result.command).toBe('unknown');
      // Fallback mode filters out options
      expect(result.args).toEqual([]);
    });
  });

  describe('Empty argv', () => {
    it('handles empty argv', () => {
      const result = parseCliArgs([], sampleCommands);
      expect(result.command).toBeUndefined();
      expect(result.args).toEqual([]);
      expect(result.options).toEqual({});
    });

    it('handles only node/script paths', () => {
      const result = parseCliArgs(['node', 'script.js'], sampleCommands);
      expect(result.command).toBeUndefined();
      expect(result.args).toEqual([]);
    });
  });

  describe('Built-in commands', () => {
    it('matches built-in commands from map', () => {
      const builtInCommands = {
        'custom create': {
          name: 'custom create',
          description: 'Custom creation command',
          options: {},
        },
      };

      const result = parseCliArgs(
        ['custom', 'create', 'test'],
        sampleCommands,
        builtInCommands,
      );
      expect(result.command).toBe('custom create');
      expect(result.args).toEqual(['test']);
    });

    it('prioritizes built-in commands over regular commands', () => {
      const builtInCommands = {
        help: {
          name: 'help',
          description: 'Built-in help',
          options: {},
        },
      };

      const result = parseCliArgs(['help'], sampleCommands, builtInCommands);
      expect(result.command).toBe('help');
    });
  });

  describe('Edge cases', () => {
    it('handles command with no options defined', () => {
      const result = parseCliArgs(['help', 'some-arg'], sampleCommands);
      expect(result.command).toBe('help');
      expect(result.args).toEqual(['some-arg']);
    });

    it('handles mixed positional args and options', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'site1', '--template=town', 'site2'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['site1', 'site2']);
      expect(result.options.template).toBe('town');
    });

    it('handles options before positional args', () => {
      const result = parseCliArgs(
        ['gnode', 'create', '--template=town', 'my-site'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['my-site']);
      expect(result.options.template).toBe('town');
    });

    // Regression test for issue #175
    it('handles local path template option (issue #175)', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'caelus', '--template', './gnode-template-smrt-module'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['caelus']);
      expect(result.options.template).toBe('./gnode-template-smrt-module');
    });

    // Regression test for issue #175 - equals syntax
    it('handles local path template option with equals (issue #175)', () => {
      const result = parseCliArgs(
        ['gnode', 'create', 'caelus', '--template=./gnode-template-smrt-module'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['caelus']);
      expect(result.options.template).toBe('./gnode-template-smrt-module');
    });

    // Regression test for issue #175 - quoted command name
    it('handles quoted multi-word command (issue #175)', () => {
      const result = parseCliArgs(
        ['gnode create', 'caelus', '--template', './gnode-template-smrt-module'],
        sampleCommands,
      );
      expect(result.command).toBe('gnode create');
      expect(result.args).toEqual(['caelus']);
      expect(result.options.template).toBe('./gnode-template-smrt-module');
    });
  });
});
