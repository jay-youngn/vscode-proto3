'use strict';

import fs = require('fs');
import path = require('path');
import vscode = require('vscode');
import fg = require('fast-glob');
import { guessScope, Proto3ScopeKind, Proto3Scope } from './proto3ScopeGuesser';
import { Proto3Import } from './proto3Import';
import { Proto3Primitive } from './proto3Primitive';

interface MessageInfo {
  name: string;
  fields: FieldInfo[];
  nestedMessages: MessageInfo[];
  nestedEnums: EnumInfo[];
  comment?: string;
  rawSource?: string;
}

interface FieldInfo {
  name: string;
  type: string;
  number: number;
  label?: string; // optional, repeated, required
  comment?: string;
}

interface EnumInfo {
  name: string;
  values: EnumValueInfo[];
  comment?: string;
  rawSource?: string;
}

interface EnumValueInfo {
  name: string;
  number: number;
  comment?: string;
}

export class Proto3HoverProvider implements vscode.HoverProvider {
  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const scope = guessScope(document, position.line);
    if (scope.kind === Proto3ScopeKind.Comment) {
      return undefined;
    }

    const targetRange = document.getWordRangeAtPosition(position, /[\w.]+/) as vscode.Range;
    const targetWord = document.getText(targetRange);

    if (!targetWord) {
      return undefined;
    }

    // Check if we are hovering over the definition of the current scope
    if ((scope.kind === Proto3ScopeKind.Message || scope.kind === Proto3ScopeKind.Enum) && scope.name === targetWord) {
      let fullName = scope.name;
      let parent = scope.parent;
      while (parent && parent.kind !== Proto3ScopeKind.Proto) {
        if (parent.name) {
          fullName = `${parent.name}.${fullName}`;
        }
        parent = parent.parent;
      }

      const info = await this.getMessageOrEnumInfo(document, fullName);
      if (info) {
        return this.createHoverForType(info);
      }
    }

    const lineText = document.lineAt(position).text;

    // Check if hovering over a primitive type
    if (Proto3Primitive.isTypePrimitive(targetWord)) {
      return this.getPrimitiveTypeHover(targetWord);
    }

    // Check if hovering over an import
    const importRegExp = new RegExp(
      `^\\s*import\\s+(\'|")((\\w+\/)*${targetWord})(\'|")\\s*;.*$`,
      'i'
    );
    if (importRegExp.test(lineText)) {
      return this.getImportHover(targetWord, document);
    }

    // Check if hovering over a message or enum type in various contexts
    const contexts = [
      // Field definition: optional/required/repeated TypeName field_name = number;
      `^\\s*(optional|repeated|required)?\\s*(${targetWord})\\s+\\w+\\s*=\\s*\\d+`,
      // Map field: map<TypeName, TypeName> field_name = number;
      `^\\s*map\\s*<\\s*${targetWord}\\s*,\\s*\\w+\\s*>\\s+\\w+\\s*=\\s*\\d+`,
      `^\\s*map\\s*<\\s*\\w+\\s*,\\s*${targetWord}\\s*>\\s+\\w+\\s*=\\s*\\d+`,
      // RPC parameter or return type
      `^\\s*rpc\\s+\\w+\\s*\\(\\s*(stream\\s+)?${targetWord}\\s*\\)`,
      `^\\s*rpc\\s+\\w+\\s*\\(\\s*(stream\\s+)?\\w+\\s*\\)\\s*returns\\s*\\(\\s*(stream\\s+)?${targetWord}\\s*\\)`,
      // Extension target
      `^\\s*extend\\s+${targetWord}\\s*{`,
    ];

    for (const context of contexts) {
      const regex = new RegExp(context, 'i');
      if (regex.test(lineText)) {
        const fullPath = this.resolveTypePath(scope, targetWord);
        const searchName = fullPath || targetWord;
        const info = await this.getMessageOrEnumInfo(document, searchName);
        if (info) {
          return this.createHoverForType(info);
        }
      }
    }

    // Check if hovering over an enum value
    const enumValueRegex = new RegExp(`^\\s*(${targetWord})\\s*=\\s*\\d+`, 'i');
    if (enumValueRegex.test(lineText)) {
      const enumInfo = await this.getContainingEnum(document, position.line);
      if (enumInfo) {
        const enumValue = enumInfo.values.find(v => v.name === targetWord);
        if (enumValue) {
          return this.createHoverForEnumValue(enumInfo, enumValue);
        }
      }
    }

    // General message/enum definition lookup
    const info = await this.getMessageOrEnumInfo(document, targetWord);
    if (info) {
      return this.createHoverForType(info);
    }

    return undefined;
  }

  private getPrimitiveTypeHover(type: string): vscode.Hover {
    const primitiveDocs: { [key: string]: string } = {
      'double': '64-bit floating point number',
      'float': '32-bit floating point number',
      'int32': '32-bit signed integer',
      'int64': '64-bit signed integer',
      'uint32': '32-bit unsigned integer',
      'uint64': '64-bit unsigned integer',
      'sint32': '32-bit signed integer (ZigZag encoding)',
      'sint64': '64-bit signed integer (ZigZag encoding)',
      'fixed32': '32-bit unsigned integer (fixed-length)',
      'fixed64': '64-bit unsigned integer (fixed-length)',
      'sfixed32': '32-bit signed integer (fixed-length)',
      'sfixed64': '64-bit signed integer (fixed-length)',
      'bool': 'Boolean value (true/false)',
      'string': 'UTF-8 encoded string',
      'bytes': 'Arbitrary byte sequence'
    };

    const doc = primitiveDocs[type] || 'Protocol buffer primitive type';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${type}** - ${doc}`);

    return new vscode.Hover(md);
  }

  private async getImportHover(importFileName: string, document: vscode.TextDocument): Promise<vscode.Hover | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const { Proto3Configuration } = await import('./proto3Configuration');
    const config = Proto3Configuration.Instance(workspaceFolder);
    const protoPaths = config.getAllProtoPathsForImport();

    // Search in all configured proto paths
    for (const protoPath of protoPaths) {
      const searchPattern = path.join(protoPath, '**', importFileName);
      const files = await fg(searchPattern);
      if (files.length > 0) {
        const importPath = files[0].toString();
        try {
          const content = fs.readFileSync(importPath, 'utf-8');

          // Extract package name
          const packageMatch = content.match(/package\s+([^;]+);/);
          const packageName = packageMatch ? packageMatch[1] : 'no package';

          // Count messages, enums, and services
          const messageCount = (content.match(/\bmessage\s+\w+/g) || []).length;
          const enumCount = (content.match(/\benum\s+\w+/g) || []).length;
          const serviceCount = (content.match(/\bservice\s+\w+/g) || []).length;

          const md = new vscode.MarkdownString();
          md.appendMarkdown(`**Import:** \`${importFileName}\`\n\n`);
          md.appendMarkdown(`**Package:** \`${packageName}\`\n\n`);
          md.appendMarkdown(`**Contents:**\n`);
          md.appendMarkdown(`- ${messageCount} message(s)\n`);
          md.appendMarkdown(`- ${enumCount} enum(s)\n`);
          md.appendMarkdown(`- ${serviceCount} service(s)\n\n`);
          md.appendMarkdown(`**Path:** \`${importPath}\``);

          return new vscode.Hover(md);
        } catch (error) {
          return undefined;
        }
      }
    }

    return undefined;
  }

  private resolveTypePath(scope: Proto3Scope, targetName: string): string | undefined {
    const parts = targetName.split('.');
    const firstPart = parts[0];

    let current: Proto3Scope | null = scope;
    while (current) {
      const found = current.children.find(child =>
        (child.kind === Proto3ScopeKind.Message || child.kind === Proto3ScopeKind.Enum) &&
        child.name === firstPart
      );

      if (found) {
        const pathParts: string[] = [];
        let iter: Proto3Scope | null = current;
        while (iter && iter.kind !== Proto3ScopeKind.Proto) {
          if (iter.name) {
            pathParts.unshift(iter.name);
          }
          iter = iter.parent;
        }
        // If the target name was already qualified (e.g. Sub.Message), we need to append the whole thing
        // But we found 'Sub' in 'current'.
        // So the full path is path_to_current + targetName.
        pathParts.push(targetName);
        return pathParts.join('.');
      }

      current = current.parent;
    }
    return undefined;
  }

  private async getMessageOrEnumInfo(document: vscode.TextDocument, targetName: string): Promise<MessageInfo | EnumInfo | undefined> {
    const searchPaths = Proto3Import.getImportedFilePathsOnDocument(document);
    const files = [document.uri.fsPath, ...(await fg(searchPaths))];

    // Also search in proto paths
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const { Proto3Configuration } = await import('./proto3Configuration');
    const config = Proto3Configuration.Instance(workspaceFolder);
    const protoPaths = config.getAllProtoPathsForImport();

    for (const protoPath of protoPaths) {
      const pathFiles = await fg(path.join(protoPath, '**', '*.proto'));
      files.push(...pathFiles);
    }

    const uniqueFiles = Array.from(new Set(files));

    // Handle dot-separated paths
    const parts = targetName.split('.');
    const rootName = parts[0];

    for (const file of uniqueFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');

        // Extract package name from the file
        const packageMatch = content.match(/package\s+([^;]+);/);
        const packageName = packageMatch ? packageMatch[1] : '';

        let matchParts = parts;
        let matchRoot = rootName;

        if (packageName && targetName.startsWith(packageName + '.')) {
          const relativeName = targetName.substring(packageName.length + 1);
          matchParts = relativeName.split('.');
          matchRoot = matchParts[0];
        }

        // Look for message or enum definition
        const messageMatch = content.match(/\bmessage\s+(\w+)\s*{/g);
        const enumMatch = content.match(/\benum\s+(\w+)\s*{/g);

        // Check for message
        if (messageMatch) {
          for (const match of messageMatch) {
            const name = match.match(/message\s+(\w+)\s*{/);
            if (name && name[1]) {
              const messageName = name[1];
              const fullName = packageName ? `${packageName}.${messageName}` : messageName;

              // Check if this matches our target (either by simple name or full qualified name)
              if (messageName === matchRoot || fullName === targetName || fullName === matchRoot) {
                let info: MessageInfo | EnumInfo = await this.parseMessage(messageName, content);

                // If we matched by package.MessageName and have no more parts, return immediately
                if (fullName === targetName) {
                  return info;
                }

                // Traverse if there are more parts (for nested types like Message.NestedMessage)
                if (matchParts.length > 1 && messageName === matchRoot) {
                  let found = true;
                  for (let i = 1; i < matchParts.length; i++) {
                    const nextName = matchParts[i];
                    if ('nestedMessages' in info) { // It's a message
                      const nestedMsg: MessageInfo | undefined = info.nestedMessages.find(m => m.name === nextName);
                      if (nestedMsg) {
                        // Create a copy with full name
                        info = { ...nestedMsg, name: `${info.name}.${nestedMsg.name}` };
                        continue;
                      }
                      const nestedEnum: EnumInfo | undefined = info.nestedEnums.find(e => e.name === nextName);
                      if (nestedEnum) {
                        // Create a copy with full name
                        info = { ...nestedEnum, name: `${info.name}.${nestedEnum.name}` };
                        continue;
                      }
                    }
                    found = false;
                    break;
                  }
                  if (found) {
                    return info;
                  }
                } else if (messageName === matchRoot && matchParts.length === 1) {
                  return info;
                }
              }
            }
          }
        }

        // Check for enum (only if it's a root enum)
        if (enumMatch) {
          for (const match of enumMatch) {
            const name = match.match(/enum\s+(\w+)\s*{/);
            if (name && name[1]) {
              const enumName = name[1];
              const fullName = packageName ? `${packageName}.${enumName}` : enumName;

              // Check if this matches our target (either by simple name or full qualified name)
              if ((enumName === matchRoot || fullName === targetName || fullName === matchRoot) && matchParts.length === 1) {
                return await this.parseEnum(enumName, content);
              }
            }
          }
        }
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }

    return undefined;
  }

  private async parseMessage(messageName: string, content: string): Promise<MessageInfo> {
    const message: MessageInfo = {
      name: messageName,
      fields: [],
      nestedMessages: [],
      nestedEnums: [],
      rawSource: ''
    };

    // Extract the raw source code for this message
    // We need to handle nested braces manually instead of using a simple regex
    const startRegex = new RegExp(`((?:\\/\\/.*\\n|\\/\\*[\\s\\S]*?\\*\\/\\s*)*)\\s*message\\s+${messageName}\\s*\\{`);
    const startMatch = startRegex.exec(content);

    if (startMatch) {
      const startIndex = startMatch.index;
      const fullStartMatch = startMatch[0];
      const openBraceIndex = startIndex + fullStartMatch.lastIndexOf('{');

      // Find matching closing brace
      let braceCount = 0;
      let endIndex = -1;

      for (let i = openBraceIndex; i < content.length; i++) {
        if (content[i] === '{') {
          braceCount++;
        } else if (content[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIndex = i;
            break;
          }
        }
      }

      if (endIndex !== -1) {
        message.rawSource = content.substring(startIndex, endIndex + 1);

        // Extract comments before the message
        const commentPart = startMatch[1];
        const commentMatch = commentPart.match(/(\/\/.*|\/\*[\s\S]*?\*\/)/g);
        if (commentMatch) {
          message.comment = commentMatch
            .map(c => c.replace(/^\/\/\s?/, '').replace(/^\/\*\s?/, '').replace(/\s?\*\/$/, '').trim())
            .join('\n');
        }

        // Parse fields from the raw source with comments
        // Split by lines and process each line
        const bodyContent = content.substring(openBraceIndex + 1, endIndex);
        const lines = bodyContent.split('\n');
      let pendingComments: string[] = [];
      let braceDepth = 0; // Track nesting depth to skip nested message/enum fields

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();

        // Collect comments that appear on separate lines (only at depth 0)
        if (trimmedLine.startsWith('//') && braceDepth === 0) {
          const comment = trimmedLine.substring(2).trim();
          if (comment) {
            pendingComments.push(comment);
          }
        } else if (!trimmedLine || trimmedLine === '{' || trimmedLine === '}') {
          // Reset comments when we encounter empty lines or braces
          if (braceDepth === 0) {
            pendingComments = [];
          }
        } else if (braceDepth === 0) {
          // Check for nested message
          const nestedMessageMatch = trimmedLine.match(/^message\s+(\w+)\s*\{/);
          const nestedEnumMatch = trimmedLine.match(/^enum\s+(\w+)\s*\{/);

          if (nestedMessageMatch) {
            const nestedName = nestedMessageMatch[1];
            const nestedInfo = await this.parseMessage(nestedName, bodyContent);
            message.nestedMessages.push(nestedInfo);
            pendingComments = [];
          } else if (nestedEnumMatch) {
            const nestedName = nestedEnumMatch[1];
            const nestedInfo = await this.parseEnum(nestedName, bodyContent);
            message.nestedEnums.push(nestedInfo);
            pendingComments = [];
          } else {
            // Only parse fields at the top level (depth 0)
            // Try to match field with optional label and comment
            // This regex matches: [label] map<key, value>|type name = number [options] ; // comment
            // Use trimmedLine to avoid issues with CRLF line endings
            const fieldMatch = trimmedLine.match(/^\s*(optional|required|repeated)?\s*(?:(map)\s*<\s*([^<>]+)\s*,\s*([^<>]+)\s*>|(\w+(?:\.\w+)*))\s+(\w+)\s*=\s*(\d+)(?:\s*\[([\s\w=,]+)\])?\s*;(?:\s*\/\/\s*(.*))?$/);
            if (fieldMatch) {
              const [, label, mapKeyword, mapKey, mapValue, regularType, name, number, options, inlineComment] = fieldMatch;
              let type: string;
              if (mapKeyword && mapKey && mapValue) {
                type = `map<${mapKey}, ${mapValue}>`;
              } else {
                type = regularType || '';
              }

              // Combine pending comments (from preceding lines) with inline comment
              const allComments = [...pendingComments];
              if (inlineComment) {
                allComments.push(inlineComment.trim());
              }

              message.fields.push({
                name,
                type,
                number: parseInt(number),
                label: label || undefined,
                comment: allComments.length > 0 ? allComments.join('\n') : undefined
              });

              // Reset pending comments after using them
              pendingComments = [];
            } else {
              // Reset comments if the line doesn't contain a field
              pendingComments = [];
            }
          }
        }

        // Track brace depth to detect nested messages/enums
        // Update depth AFTER processing the line to correctly handle fields before nested structures
        const openBraces = (line.match(/\{/g) || []).length;
        const closeBraces = (line.match(/\}/g) || []).length;
        braceDepth += openBraces - closeBraces;
      }
    }
    }

    return message;
  }

  private async parseEnum(enumName: string, content: string): Promise<EnumInfo> {
    const enumInfo: EnumInfo = {
      name: enumName,
      values: [],
      rawSource: ''
    };

    // Extract the raw source code for this enum
    const enumRegex = new RegExp(`((?:\\/\\/.*\\n|\\/\\*[\\s\\S]*?\\*\\/\\s*)*)\\s*enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'g');
    const match = enumRegex.exec(content);

    if (match) {
      enumInfo.rawSource = match[0];
      // Extract comments before the enum
      const commentMatch = match[1].match(/(\/\/.*|\/\*[\s\S]*?\*\/)/g);
      if (commentMatch) {
        enumInfo.comment = commentMatch
          .map(c => c.replace(/^\/\/\s?/, '').replace(/^\/\*\s?/, '').replace(/\s?\*\/$/, '').trim())
          .join('\n');
      }

      // Parse enum values from the raw source
      const lines = match[2].split('\n');
      let pendingComments: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();

        // Collect comments that appear on separate lines
        if (trimmedLine.startsWith('//')) {
          const comment = trimmedLine.substring(2).trim();
          if (comment) {
            pendingComments.push(comment);
          }
        } else if (!trimmedLine || trimmedLine === '{' || trimmedLine === '}') {
          // Reset comments when we encounter empty lines or braces
          pendingComments = [];
        } else {
          // Try to match enum value with optional inline comment
          // Use trimmedLine to avoid issues with CRLF line endings
          const valueMatch = trimmedLine.match(/^\s*(\w+)\s*=\s*(\d+)\s*;(?:\s*\/\/\s*(.*))?$/);
          if (valueMatch) {
            const [, name, number, inlineComment] = valueMatch;

            // Combine pending comments (from preceding lines) with inline comment
            const allComments = [...pendingComments];
            if (inlineComment) {
              allComments.push(inlineComment.trim());
            }

            enumInfo.values.push({
              name,
              number: parseInt(number),
              comment: allComments.length > 0 ? allComments.join('\n') : undefined
            });

            // Reset pending comments after using them
            pendingComments = [];
          } else {
            // Reset comments if the line doesn't contain an enum value
            pendingComments = [];
          }
        }
      }
    }

    return enumInfo;
  }

  private createHoverForType(info: MessageInfo | EnumInfo): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.isTrusted = true; // Enable HTML support for styling

    if ('fields' in info) {
      // Message
      md.appendMarkdown(`**message ${info.name}**\n\n`);

      if (info.comment) {
        md.appendMarkdown(`${info.comment}\n\n`);
      }

      if (info.fields.length > 0) {
        md.appendMarkdown('**Fields:**\n');
        for (const field of info.fields) {
          const label = field.label ? `${field.label} ` : '';
          if (field.comment) {
            // Convert multi-line comments to proper markdown format
            // Use space for replace line breaks in HTML span to keep it inside the comment block
            const formattedComment = field.comment.includes('\n')
              ? field.comment.split('\n').filter(line => line.trim()).join(' ')
              : field.comment;
            md.appendMarkdown(`- \`${field.name}: ${label}${field.type}\` = ${field.number}; *// ${formattedComment}*\n`);
          } else {
            md.appendMarkdown(`- \`${field.name}: ${label}${field.type}\` = ${field.number};\n`);
          }
        }
      }

      if (info.nestedMessages.length > 0) {
        md.appendMarkdown('\n**Nested Messages:**\n');
        for (const nested of info.nestedMessages) {
          const nestedComment = nested.comment ? ` *// ${nested.comment}*` : '';
          md.appendMarkdown(`- \`${nested.name}\`${nestedComment}\n`);
        }
      }

      if (info.nestedEnums.length > 0) {
        md.appendMarkdown('\n**Nested Enums:**\n');
        for (const nested of info.nestedEnums) {
          const nestedComment = nested.comment ? ` *// ${nested.comment}*` : '';
          md.appendMarkdown(`- \`${nested.name}\`${nestedComment}\n`);
        }
      }
    } else {
      // Enum
      md.appendMarkdown(`**enum ${info.name}**\n\n`);

      if (info.comment) {
        md.appendMarkdown(`${info.comment}\n\n`);
      }

      if (info.values.length > 0) {
        md.appendMarkdown('**Values:**\n');
        for (const value of info.values) {
          if (value.comment) {
            // Convert multi-line comments to proper markdown format
            // Use space for replace line breaks in HTML span to keep it inside the comment block
            const formattedComment = value.comment.includes('\n')
              ? value.comment.split('\n').filter(line => line.trim()).join(' ')
              : value.comment;
            md.appendMarkdown(`- \`${value.name}\` = ${value.number}; *// ${formattedComment}*\n`);
          } else {
            md.appendMarkdown(`- \`${value.name}\` = ${value.number};\n`);
          }
        }
      }
    }

    return new vscode.Hover(md);
  }

  private createHoverForEnumValue(enumInfo: EnumInfo, enumValue: EnumValueInfo): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    md.appendMarkdown(`\`${enumValue.name}\` = ${enumValue.number}`);
    if (enumValue.comment) {
      md.appendMarkdown(` *// ${enumValue.comment}*`);
    }
    md.appendMarkdown('\n\n');
    md.appendMarkdown(`Enum: \`${enumInfo.name}\``);

    return new vscode.Hover(md);
  }

  private async getContainingMessage(document: vscode.TextDocument, line: number): Promise<MessageInfo | undefined> {
    const content = document.getText();
    const lines = content.split('\n');

    // Find the message that contains this line
    let messageStack: { name: string, depth: number }[] = [];
    let currentDepth = 0;

    for (let i = 0; i <= line; i++) {
      const lineText = lines[i];
      // Remove comments for brace counting
      const codeLine = lineText.replace(/\/\/.*$/, '');

      // Check for message definition start
      const messageMatch = codeLine.match(/\bmessage\s+(\w+)\s*\{/);
      if (messageMatch) {
        messageStack.push({ name: messageMatch[1], depth: currentDepth });
      }

      // Count braces
      const openBraces = (codeLine.match(/\{/g) || []).length;
      const closeBraces = (codeLine.match(/\}/g) || []).length;

      currentDepth += openBraces - closeBraces;

      // Check if we closed a message
      while (messageStack.length > 0 && currentDepth <= messageStack[messageStack.length - 1].depth) {
        messageStack.pop();
      }
    }

    if (messageStack.length > 0) {
      const lastMessage = messageStack[messageStack.length - 1];
      return await this.parseMessage(lastMessage.name, content);
    }

    return undefined;
  }

  private async getContainingEnum(document: vscode.TextDocument, line: number): Promise<EnumInfo | undefined> {
    const content = document.getText();
    const lines = content.split('\n');

    // Find the enum that contains this line
    let currentEnum: EnumInfo | undefined;
    let inEnum = false;

    for (let i = 0; i <= line; i++) {
      const trimmedLine = lines[i].trim();

      if (trimmedLine.startsWith('enum ')) {
        const match = trimmedLine.match(/enum\s+(\w+)\s*{/);
        if (match) {
          currentEnum = await this.parseEnum(match[1], content);
          inEnum = true;
        }
      } else if (inEnum && trimmedLine === '}') {
        inEnum = false;
        currentEnum = undefined;
      }
    }

    return currentEnum;
  }
}
