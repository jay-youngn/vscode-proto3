'use strict';

import vscode = require('vscode');
import path = require('path');
import fs = require('fs');
import os = require('os');

export class Proto3Configuration {
  private readonly _configSection: string = 'protoc';
  private _config: vscode.WorkspaceConfiguration;
  private _configResolver: ConfigurationResolver;

  public static Instance(workspaceFolder?: vscode.WorkspaceFolder): Proto3Configuration {
    return new Proto3Configuration(workspaceFolder);
  }

  private constructor(workspaceFolder?: vscode.WorkspaceFolder) {
    this._config = vscode.workspace.getConfiguration(this._configSection, workspaceFolder);
    this._configResolver = new ConfigurationResolver(workspaceFolder);
  }

  public getProtocPath(protocInPath: boolean): string {
    const protoc = protocInPath ? 'protoc' : '?';
    return this._configResolver.resolve(this._config.get<string>('path', protoc));
  }

  public getProtoSourcePath(): string {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return vscode.workspace.rootPath ?? '';
    }
    const activeEditorUri = activeEditor.document.uri;
    const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
    const defaultPath = activeWorkspaceFolder?.uri.path ?? vscode.workspace.rootPath ?? '';
    return this._configResolver.resolve(this._config.get<string>('compile_all_path', defaultPath));
  }

  public getProtocArgs(): string[] {
    return this._configResolver.resolve(this._config.get<string[]>('options', []));
  }

  public getProtocArgFiles(): string[] {
    return this.getProtocArgs().filter(arg => !arg.startsWith('-'));
  }

  /**
   * Get merged protoc options from multiple configuration levels
   * Priority order: Current workspace folder -> Workspace -> User settings
   */
  public getMergedProtocOptions(): string[] {
    const mergedOptions: string[] = [];
    const seenProtoPaths = new Set<string>();
    const seenOtherOptions = new Set<string>();

    // 1. Get current workspace folder configuration (highest priority)
    const currentFolderConfig = this._config;
    const currentOptions = this._configResolver.resolve(currentFolderConfig.get<string[]>('options', []));

    // 2. Get workspace-level configuration (without specific folder)
    const workspaceConfig = vscode.workspace.getConfiguration(this._configSection);
    const workspaceOptions = this._configResolver.resolve(workspaceConfig.get<string[]>('options', []));

    // 3. Process options in reverse priority order to avoid duplication
    // Process user settings (implicitly handled by vscode API)
    // Then workspace settings
    this.processOptions(workspaceOptions, mergedOptions, seenProtoPaths, seenOtherOptions);

    // Finally, current workspace folder settings (highest priority)
    this.processOptions(currentOptions, mergedOptions, seenProtoPaths, seenOtherOptions);

    return mergedOptions;
  }

  /**
   * Process options and add them to merged list while avoiding duplicates
   */
  private processOptions(
    options: string[],
    mergedOptions: string[],
    seenProtoPaths: Set<string>,
    seenOtherOptions: Set<string>
  ): void {
    for (const option of options) {
      if (this.isProtoPathOption(option)) {
        const pathValue = this.extractProtoPathValue(option);
        if (pathValue && !seenProtoPaths.has(pathValue)) {
          mergedOptions.push(option);
          seenProtoPaths.add(pathValue);
        }
      } else {
        // For non-proto_path options, check exact duplicates
        if (!seenOtherOptions.has(option)) {
          mergedOptions.push(option);
          seenOtherOptions.add(option);
        }
      }
    }
  }

  /**
   * Check if an option is a proto_path option
   */
  private isProtoPathOption(option: string): boolean {
    return option.startsWith('--proto_path') || option.startsWith('-I');
  }

  /**
   * Extract the path value from a proto_path option
   */
  private extractProtoPathValue(option: string): string | null {
    if (option.startsWith('--proto_path=')) {
      return option.substring('--proto_path='.length);
    } else if (option.startsWith('-I') && option.length > 2) {
      return option.substring(2);
    } else if (option === '-I') {
      // This case is handled in getProtoPathOptions where -I is separate from its path
      return null;
    }
    return null;
  }

  public getProtoPathOptions(): string[] {
    return this.getMergedProtocOptions().filter(
      opt => opt.startsWith('--proto_path') || opt.startsWith('-I')
    );
  }

  public getAllProtoPaths(): string[] {
    return this.useAbsolutePath()
      ? ProtoFinder.fromDirAbsolute(this.getProtoSourcePath())
      : this.getProtocArgFiles().concat(ProtoFinder.fromDir(this.getProtoSourcePath()));
  }

  public getTmpJavaOutOption(): string {
    return '--java_out=' + os.tmpdir();
  }

  public compileOnSave(): boolean {
    return this._config.get<boolean>('compile_on_save', false);
  }

  public renumberOnSave(): boolean {
    return this._config.get<boolean>('renumber_on_save', false);
  }

  public useAbsolutePath(): boolean {
    return this._config.get<boolean>('use_absolute_path', false);
  }

  public getAllProtoPathsForImport(): string[] {
    // Combine workspace root and merged protoc proto_path options
    const paths: string[] = [];
    const workspaceRoot = vscode.workspace.rootPath;

    // Add workspace root (current behavior) for backward compatibility
    if (workspaceRoot) {
      paths.push(workspaceRoot);
    }

    // Add paths from merged protoc options (--proto_path or -I)
    const protoPathOptions = this.getProtoPathOptions();
    for (let i = 0; i < protoPathOptions.length; i++) {
      const option = protoPathOptions[i];
      if (option.startsWith('--proto_path=')) {
        const protoPath = option.substring('--proto_path='.length);
        if (protoPath) {
          paths.push(protoPath);
        }
      } else if (option.startsWith('-I') && option.length > 2) {
        // Handle -I<path>
        const pathValue = option.substring(2);
        if (pathValue) {
          paths.push(pathValue);
        }
      } else if (option === '-I') {
        // Handle case where -I is separated from path
        if (i + 1 < protoPathOptions.length) {
          const nextOption = protoPathOptions[i + 1];
          if (!nextOption.startsWith('-')) {
            paths.push(nextOption);
            i++; // Skip the next option since it's consumed as a path
          }
        }
      }
    }

    // Remove duplicates and resolve relative paths
    const uniquePaths = new Set<string>();
    let warnedAboutRelativePath = false;
    for (const searchPath of paths) {
      if (path.isAbsolute(searchPath)) {
        uniquePaths.add(path.resolve(searchPath));
      } else if (workspaceRoot) {
        uniquePaths.add(path.resolve(workspaceRoot, searchPath));
      } else {
        uniquePaths.add(path.resolve(process.cwd(), searchPath));
        if (!warnedAboutRelativePath) {
          console.warn(
            `[protoc] Relative proto path "${searchPath}" resolved against current working directory (${process.cwd()}) because workspace root is undefined.`
          );
          warnedAboutRelativePath = true;
        }
      }
    }

    return Array.from(uniquePaths);
  }
}

class ProtoFinder {
  static fromDir(root: string): string[] {
    const search = function (dir: string): string[] {
      const files = fs.readdirSync(dir);

      let protos = files
        .filter(file => file.endsWith('.proto'))
        .map(file => path.join(path.relative(root, dir), file));

      files
        .map(file => path.join(dir, file))
        .filter(file => fs.statSync(file).isDirectory())
        .forEach(subDir => {
          protos = protos.concat(search(subDir));
        });

      return protos;
    };
    return search(root);
  }

  static fromDirAbsolute(root: string): string[] {
    const files: string[] = [];
    const getFilesRecursively = (directory: string) => {
      const filesInDirectory = fs.readdirSync(directory);
      for (const file of filesInDirectory) {
        const absolute = path.join(directory, file);
        if (fs.statSync(absolute).isDirectory()) getFilesRecursively(absolute);
        else files.push(absolute);
      }
    };
    getFilesRecursively(root);
    return files;
  }
}

// Workaround to substitute variable keywords in the configuration value until
// workbench/services/configurationResolver is available on Extention API.
//
//
// Some codes are copied from:
// src/vs/workbench/services/configurationResolver/node/configurationResolverService.ts
class ConfigurationResolver {
  [key: string]: unknown;

  constructor(private readonly workspaceFolder?: vscode.WorkspaceFolder) {
    Object.keys(process.env).forEach(key => {
      this[`env.${key}`] = process.env[key];
    });
  }

  public resolve(value: string): string;
  public resolve(value: string[]): string[];
  public resolve(value: string | string[]): string | string[] {
    if (typeof value === 'string') {
      return this.resolveString(value);
    } else if (this.isArray(value)) {
      return this.resolveArray(value);
    }
    return value;
  }

  private isArray(array: unknown): array is string[] {
    if (Array.isArray) {
      return Array.isArray(array);
    }

    if (
      array &&
      typeof (array as { length?: unknown }).length === 'number' &&
      (array as object).constructor === Array
    ) {
      return true;
    }

    return false;
  }

  private resolveArray(value: string[]): string[] {
    return value.map(s => this.resolveString(s));
  }

  private resolveString(value: string): string {
    const regexp = /\$\{(.*?)\}/g;
    const originalValue = value;
    const resolvedString = value.replace(regexp, (match: string, name: string) => {
      const newValue = this[name];
      if (typeof newValue === 'string') {
        return newValue;
      } else {
        return match && match.indexOf('env.') > 0 ? '' : match;
      }
    });

    return this.resolveConfigVariable(resolvedString, originalValue);
  }

  private resolveConfigVariable(value: string, originalValue: string): string {
    const regexp = /\$\{config\.(.+?)\}/g;
    return value.replace(regexp, (match: string, name: string) => {
      let config: vscode.WorkspaceConfiguration | Record<string, unknown> =
        vscode.workspace.getConfiguration(undefined, this.workspaceFolder);
      let newValue: unknown;
      try {
        const keys: string[] = name.split('.');
        if (!keys || keys.length <= 0) {
          return '';
        }
        while (keys.length > 1) {
          const key = keys.shift();
          if (!key || !config || !Object.prototype.hasOwnProperty.call(config, key)) {
            return '';
          }
          config = config[key];
        }
        newValue =
          config && Object.prototype.hasOwnProperty.call(config, keys[0]) ? config[keys[0]] : '';
      } catch {
        return '';
      }
      if (typeof newValue === 'string') {
        // Prevent infinite recursion and also support nested references (or tokens)
        return newValue === originalValue ? '' : this.resolveString(newValue);
      } else if (Array.isArray(newValue)) {
        return this.resolveArray(newValue).join(',');
      } else {
        return String(newValue ?? '');
      }
    });
  }

  private get workspaceRoot(): string {
    return vscode.workspace.rootPath ?? '';
  }
}
