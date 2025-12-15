# vscode-proto3-next

[![Version](https://img.shields.io/visual-studio-marketplace/v/jay-youngn.vscode-proto3-next?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=jay-youngn.vscode-proto3-next)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/jay-youngn.vscode-proto3-next)](https://marketplace.visualstudio.com/items?itemName=jay-youngn.vscode-proto3-next)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/jay-youngn/vscode-proto3/blob/master/LICENSE.txt)

Protobuf 3 support for Visual Studio Code

> Salute to the long-standing [zxh0/vscode-proto3](https://github.com/zxh0/vscode-proto3) extension that has accompanied us for so long. <br>
> This is an excellent and concise extension in VSCode, and it is well worth our continuous effort to make small optimizations.

## ✨ New Features

This extension extends the original functionality with significant improvements:

- **Enhanced Import Resolution**: Automatically resolves imports using paths defined in `protoc.options`, enabling reliable "Go to Definition" across your workspace.
- **Rich Hover Support**:
  - **Definition Preview**: Hover over message or enum types to view their complete definition, including fields and numbers.
  - **Nested Structures**: Full support for visualizing nested messages and enums.
  - **Formatted Documentation**: Comments are beautifully formatted, preserving multi-line structures.

## 📚 Release Notes

See [CHANGELOG.md](CHANGELOG.md).

-----

## ⚠️ vscode-proto3 (Archived)

### VSCode Commands

_By default **ctrl-shift-p** opens the command prompt._

| Command | Description |
|---------|-------------|
| `proto3: Compile All Protos` | Compiles all workspace protos using [configurations](#extension-settings) defined with `protoc.options`. |
| `proto3: Compile This Proto` | Compiles the active proto using [configurations](#extension-settings) defined with `protoc.options`. |

### Features

- Syntax highlighting
- Syntax validation
- Code snippets
- Code completion
- Code formatting
- Brace matching
- Line and block commenting
- Compilation

#### Syntax Highlighting

The grammar is written in tmLanguage JSON format.

#### Syntax Validation

The validation is triggered when you save the proto file. You need protoc
compiler to enable syntax validation. You also need a settings.json file
to tell the extension the full path of protoc if it is not in `path`.

#### Extension Settings

Below is an example settings.json file which comes from
[example/.vscode](https://github.com/jay-youngn/vscode-proto3/tree/master/example/.vscode):
```json
{
    "protoc": {
        "path": "/path/to/protoc",
        "compile_on_save": false,
        "options": [
            "--proto_path=protos/v3",
            "--proto_path=protos/v2",
            "--proto_path=${workspaceRoot}/proto",
            "--proto_path=${env.GOPATH}/src",
            "--java_out=gen/java"
        ]
    }
}
```

##### Fields

The possible fields under the `protoc` extension settings which can be defined in a `settings.json` file.

| Field            | Type     | Default          | Description                                                                    |
| ---------------- | -------- | ---------------- | ------------------------------------------------------------------------------ |
| path             | string   | _protoc in PATH_ | Path to protoc. Defaults to protoc in PATH if omitted.                         |
| compile_on_save  | boolean  | false            | On `.proto` file save, compiles to `--*_out` location within `options`         |
| compile_all_path | string   | Workspace Root   | Search Path for `Compile All Protos` action. Defaults to the Workspace Root    |
| use_absolute_path| boolean  | false            | Set `true` for `compile_all_path` search files using absolute path             |
| options          | string[] | []               | protoc compiler arguments/flags, required for proto validation and compilation |


##### In-Line Variables

These variables can be used to inject variables strings within the `protoc` extension configurations. See above for examples.

| Variable      | Description                              |
| ------------- | ---------------------------------------- |
| config.*      | Refer settings items in ``Preferences``. |
| env.*         | Refer environment variable.              |
| workspaceRoot | Returns current workspace root path.     |

#### Code Completion

A very simple parser is written to support code completion.

#### Code Snippets

| prefix | body                                           |
| ------ | ---------------------------------------------- |
| sp2    | `syntax = "proto2";`                           |
| sp3    | `syntax = "proto3";`                           |
| pkg    | `package package.name;`                        |
| imp    | `import "path/to/other/protos.proto";`         |
| ojp    | `option java_package = "java.package.name";`   |
| ojoc   | `option java_outer_classname = "ClassName";`   |
| o4s    | `option optimize_for = SPEED;`                 |
| o4cs   | `option optimize_for = CODE_SIZE;`             |
| o4lr   | `option optimize_for = LITE_RUNTIME;`          |
| odep   | `option deprecated = true;`                    |
| oaa    | `option allow_alias = true;`                   |
| msg    | `message MessageName {}`                       |
| fbo    | `bool field_name = tag;`                       |
| fi32   | `int32 field_name = tag;`                      |
| fi64   | `int64 field_name = tag;`                      |
| fu32   | `uint32 field_name = tag;`                     |
| fu64   | `uint64 field_name = tag;`                     |
| fs32   | `sint32 field_name = tag;`                     |
| fs64   | `sint64 field_name = tag;`                     |
| ff32   | `fixed32 field_name = tag;`                    |
| ff64   | `fixed64 field_name = tag;`                    |
| fsf32  | `sfixed32 field_name = tag;`                   |
| fsf64  | `sfixed64 field_name = tag;`                   |
| ffl    | `float field_name = tag;`                      |
| fdo    | `double field_name = tag;`                     |
| fst    | `string field_name = tag;`                     |
| fby    | `bytes field_name = tag;`                      |
| fm     | `map<key, val> field_name = tag;`              |
| foo    | `oneof name {}`                                |
| en     | `enum EnumName {}`                             |
| sv     | `service ServiceName {}`                       |
| rpc    | `rpc MethodName (Request) returns (Response);` |

#### Google API Design Guide

The following snippets are based on
[Google API Design Guide](https://cloud.google.com/apis/design/).

| prefix | reference                                                                 |
| ------ | ------------------------------------------------------------------------- |
| svgapi | [Standard Methods](https://cloud.google.com/apis/design/standard_methods) |

### Code Formatting

Support "Format Document" if `clang-format` is in path, including custom `style` options.

By default, `clang-format`'s standard coding style will be used for formatting. To define a custom style or use a supported preset add `"clang-format.style"` in VSCode Settings (`settings.json`)

#### Example usage

`"clang-format.style": "google"`

This is the equivalent of executing `clang-format -style=google` from the shell.

With multiple formatting options

`"clang-format.style": "{ IndentWidth: 4, BasedOnStyle: google, AlignConsecutiveAssignments: true }"`

For further formatting options refer to the [official `clang-format` documentation](https://clang.llvm.org/docs/ClangFormatStyleOptions.html)

### Known Issues

Auto-completion does not work in some situations.

Some users consistently see an error like `spawnsync clang-format enoent` when they save. This happens when the "formatOnSave"-setting is enabled in VSCode and "clang-format" cannot be found. To fix this:

#### On MacOS

1. Install clang-format on your system: `brew install clang-format`
2. Install the `clang-format` plugin in VSCode

### Release Notes

See [CHANGELOG.md](CHANGELOG.md).
