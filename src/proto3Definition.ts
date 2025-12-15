'use strict';

import fs = require('fs');
import path = require('path');
import vscode = require('vscode');
import fg = require('fast-glob');
import { guessScope, Proto3ScopeKind } from './proto3ScopeGuesser';
import { Proto3Import } from './proto3Import';
import { Proto3Primitive } from './proto3Primitive';

export class Proto3DefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const scope = guessScope(document, position.line);
    if (scope.kind === Proto3ScopeKind.Comment) {
      return undefined;
    }

    const targetRange = document.getWordRangeAtPosition(position, /[\w.]+/);
    const targetDefinition = targetRange
      ? document.getText(targetRange)
      : document.getWordRangeAtPosition(position)
      ? document.getText(document.getWordRangeAtPosition(position)!)
      : '';

    if (!targetDefinition) {
      return undefined;
    }

    if (Proto3Primitive.isTypePrimitive(targetDefinition)) {
      return undefined;
    }

    const lineText = document.lineAt(position).text;

    const importRegExp = new RegExp(
      `^\\s*import\\s+(\'|")((\\w+\/)*${targetDefinition})(\'|")\\s*;.*$`,
      'i'
    );
    const matchedGroups = importRegExp.exec(lineText);
    if (matchedGroups && matchedGroups.length == 5) {
      const importFilePath = matchedGroups[2];
      const location = await this.findImportDefinition(importFilePath);
      if (location) {
        return location;
      }
      // Show subtle status bar message for missing reference
      vscode.window.setStatusBarMessage(`Could not find ${targetDefinition} definition`, 3000);
    }
    const messageOrEnumPattern = `\\s*(\\w+\\.)*\\w+\\s*`;
    const messageFieldPattern = `\\s+\\w+\\s*=\\s*\\d+;.*`;
    const rpcReqOrRspPattern = `\\s*\\(\\s*(stream\\s+)?${messageOrEnumPattern}\\s*\\)\\s*`;

    const messageRegExp = new RegExp(
      `^\\s*(optional|repeated)?\\s*(${messageOrEnumPattern})${messageFieldPattern}$`,
      'i'
    );
    const messageInMap = new RegExp(
      `^\\s*map\\s*<${messageOrEnumPattern},${messageOrEnumPattern}>${messageFieldPattern}$`,
      'i'
    );
    const messageInRpcRegExp = new RegExp(
      `^\\s*rpc\\s*\\w+${rpcReqOrRspPattern}returns${rpcReqOrRspPattern}[;{].*$`,
      'i'
    );

    if (
      messageRegExp.test(lineText) ||
      messageInRpcRegExp.test(lineText) ||
      messageInMap.test(lineText)
    ) {
      const location = await this.findEnumOrMessageDefinition(document, targetDefinition);
      if (location) {
        return location;
      }
      // Show subtle status bar message for missing reference
      vscode.window.setStatusBarMessage(`Could not find ${targetDefinition} definition`, 3000);
    }

    return undefined;
  }

  private async findEnumOrMessageDefinition(
    document: vscode.TextDocument,
    target: string
  ): Promise<vscode.Location | undefined> {
    const searchPaths = Proto3Import.getImportedFilePathsOnDocument(document);

    const files = [document.uri.fsPath, ...(await fg(searchPaths))];

    // Also search in proto paths for any files that might not be directly imported
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const { Proto3Configuration } = await import('./proto3Configuration');
    const config = Proto3Configuration.Instance(workspaceFolder);
    const protoPaths = config.getAllProtoPathsForImport();

    for (const protoPath of protoPaths) {
      const pathFiles = await fg(path.join(protoPath, '**', '*.proto'));
      files.push(...pathFiles);
    }

    const uniqueFiles = Array.from(new Set(files));
    for (const file of uniqueFiles) {
      const data = fs.readFileSync(file.toString());
      const lines = data.toString().split('\n');

      let packageName = '';
      for (const line of lines) {
        const packageMatch = line.match(/^\s*package\s+([\w.]+)\s*;/);
        if (packageMatch) {
          packageName = packageMatch[1];
          break;
        }
      }

      if (target.includes('.')) {
        let parts = target.split('.');
        if (packageName && target.startsWith(packageName + '.')) {
          const packageParts = packageName.split('.');
          let match = true;
          for (let i = 0; i < packageParts.length; i++) {
            if (parts[i] !== packageParts[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            parts = parts.slice(packageParts.length);
          }
        }

        const location = this.findNestedDefinition(lines, parts, file.toString());
        if (location) {
          return location;
        }
      } else {
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];
          const messageDefinitionRegexMatch = new RegExp(`\\s*(message|enum)\\s*${target}\\s*{`).exec(
            line
          );
          if (messageDefinitionRegexMatch && messageDefinitionRegexMatch.length) {
            const uri = vscode.Uri.file(file.toString());
            const range = this.getTargetLocationInline(
              lineIndex,
              line,
              target,
              messageDefinitionRegexMatch
            );
            return new vscode.Location(uri, range);
          }
        }
      }
    }
    return undefined;
  }

  private findNestedDefinition(
    lines: string[],
    parts: string[],
    filePath: string,
    startLine: number = 0,
    endLine: number = -1
  ): vscode.Location | undefined {
    if (endLine === -1) {
      endLine = lines.length;
    }
    if (parts.length === 0) {
      return undefined;
    }
    const currentPart = parts[0];
    const remainingParts = parts.slice(1);

    for (let i = startLine; i < endLine; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//')) {
        continue;
      }

      const definitionRegex = new RegExp(`\\s*(message|enum|service)\\s+${currentPart}\\s*\\{`);
      const match = definitionRegex.exec(line);

      if (match) {
        if (remainingParts.length === 0) {
          const uri = vscode.Uri.file(filePath);
          const range = this.getTargetLocationInline(i, line, currentPart, match);
          return new vscode.Location(uri, range);
        } else {
          const blockEnd = this.findBlockEnd(lines, i);
          const actualEnd = Math.min(blockEnd, endLine);
          const innerLocation = this.findNestedDefinition(
            lines,
            remainingParts,
            filePath,
            i + 1,
            actualEnd
          );
          if (innerLocation) {
            return innerLocation;
          }
          i = blockEnd;
        }
      }
    }
    return undefined;
  }

  private findBlockEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      const cleanLine = line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\//, '');
      const open = (cleanLine.match(/{/g) || []).length;
      const close = (cleanLine.match(/}/g) || []).length;
      braceCount += open - close;
      if (braceCount <= 0 && i >= startLine) {
        return i;
      }
    }
    return lines.length;
  }

  private async findImportDefinition(importFileName: string): Promise<vscode.Location | undefined> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    const { Proto3Configuration } = await import('./proto3Configuration');
    const config = Proto3Configuration.Instance(workspaceFolder);
    const protoPaths = config.getAllProtoPathsForImport();

    // Search in all configured proto paths
    for (const protoPath of protoPaths) {
      const searchPattern = path.join(protoPath, '**', importFileName);
      const files = await fg(searchPattern);
      if (files.length > 0) {
        const importPath = files[0].toString();
        const uri = vscode.Uri.file(importPath);
        const definitionStartPosition = new vscode.Position(0, 0);
        const definitionEndPosition = new vscode.Position(0, 0);
        const range = new vscode.Range(definitionStartPosition, definitionEndPosition);
        return new vscode.Location(uri, range);
      }
    }

    return undefined;
  }

  private getTargetLocationInline(
    lineIndex: number,
    line: string,
    target: string,
    definitionRegexMatch: RegExpExecArray
  ): vscode.Range {
    const matchedStr = definitionRegexMatch[0];
    const index = line.indexOf(matchedStr) + matchedStr.indexOf(target);
    const definitionStartPosition = new vscode.Position(lineIndex, index);
    const definitionEndPosition = new vscode.Position(lineIndex, index + target.length);
    return new vscode.Range(definitionStartPosition, definitionEndPosition);
  }
}
