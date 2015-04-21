/// <reference path="./typings/tsd" />

import fs = require('fs');
import glob = require('glob');
import mkdirp = require('mkdirp');
import os = require('os');
import pathUtil = require('path');
import Promise = require('bluebird');
import ts = require('typescript');

interface Options {
	baseDir: string;
	files: string[];
	excludes?: string[];
	externs?: string[];
	eol?: string;
	includes?: string[];
	indent?: string;
	main?: string;
	name: string;
	out: string;
	target?: ts.ScriptTarget;
}

var filenameToMid:(filename: string) => string = (function () {
	if (pathUtil.sep === '/') {
		return function (filename: string) {
			return filename;
		};
	}
	else {
		var separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
		return function (filename: string) {
			return filename.replace(separatorExpression, '/');
		};
	}
})();

function getError(diagnostics: ts.Diagnostic[]) {
	var message = 'Declaration generation failed';

	diagnostics.forEach(function (diagnostic) {
		var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

		message +=
			`\n${diagnostic.file.fileName}(${position.line + 1},${position.character + 1}): ` +
			`error TS${diagnostic.code}: ${diagnostic.messageText}`;
	});

	var error = new Error(message);
	error.name = 'EmitterError';
	return error;
}

function getFilenames(baseDir: string, files:string[]): string[] {
	return files.map(function (filename) {
		var resolvedFilename = pathUtil.resolve(filename);
		if (resolvedFilename.indexOf(baseDir) === 0) {
			return resolvedFilename;
		}

		return pathUtil.resolve(baseDir, filename);
	});
}

function processTree(sourceFile: ts.SourceFile, replacer:(node: ts.Node) => string): string {
	var code = '';
	var cursorPosition = 0;

	function skip(node: ts.Node) {
		cursorPosition = node.end;
	}

	function readThrough(node: ts.Node) {
		code += sourceFile.text.slice(cursorPosition, node.pos);
		cursorPosition = node.pos;
	}

	function visit(node: ts.Node) {
		readThrough(node);

		var replacement = replacer(node);

		if (replacement != null) {
			code += replacement;
			skip(node);
		}
		else {
			ts.forEachChild(node, visit);
		}
	}

	visit(sourceFile);
	code += sourceFile.text.slice(cursorPosition);

	return code;
}

export function generate(options: Options, sendMessage: (message: string) => void = function () {}) {
	var baseDir = pathUtil.resolve(options.baseDir);
	var eol = options.eol || os.EOL;
	var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
	var indent = options.indent === undefined ? '\t' : options.indent;
	var target = options.target || ts.ScriptTarget.Latest;
	var compilerOptions: ts.CompilerOptions = {
		declaration: true,
		module: ts.ModuleKind.CommonJS,
		target: target
	};

	var filenames = getFilenames(baseDir, options.files);
	var excludesMap: { [filename: string]: boolean; } = {};
	options.excludes && options.excludes.forEach(function (filename) {
		excludesMap[pathUtil.resolve(baseDir, filename)] = true;
	});

	mkdirp.sync(pathUtil.dirname(options.out));
	var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });

	var host = ts.createCompilerHost(compilerOptions);
	var program = ts.createProgram(filenames, compilerOptions, host);
	var checker = ts.createTypeChecker(program, true);

	function writeFile(filename: string, data: string, writeByteOrderMark: boolean) {
		// Compiler is emitting the non-declaration file, which we do not care about
		if (filename.slice(-5) !== '.d.ts') {
			return;
		}

		writeDeclaration(ts.createSourceFile(filename, data, target, true));
	}

	return new Promise<void>(function (resolve, reject) {
		output.on('close', () => { resolve(undefined); });
		output.on('error', reject);

		if (options.externs) {
			options.externs.forEach(function (path: string) {
				sendMessage(`Writing external dependency ${path}`);
				output.write(`/// <reference path="${path}" />` + eol);
			});
		}

		program.getSourceFiles().some(function (sourceFile) {
			// Source file is a default library, or other dependency from another project, that should not be included in
			// our bundled output
			if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
				return;
			}

			if (excludesMap[sourceFile.fileName]) {
				return;
			}

			sendMessage(`Processing ${sourceFile.fileName}`);

			// Source file is already a declaration file so should does not need to be pre-processed by the emitter
			if (sourceFile.fileName.slice(-5) === '.d.ts') {
				writeDeclaration(sourceFile);
				return;
			}

			var emitOutput = program.emit(sourceFile, writeFile);
			if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
				reject(getError(
					emitOutput.diagnostics
						.concat(program.getSemanticDiagnostics(sourceFile))
						.concat(program.getSyntacticDiagnostics(sourceFile))
						.concat(program.getDeclarationDiagnostics(sourceFile))
				));

				return true;
			}
		});

		if (options.main) {
			output.write(`declare module '${options.name}' {` + eol + indent);
			output.write(`import main = require('${options.main}');` + eol + indent);
			output.write('export = main;' + eol);
			output.write('}' + eol);
			sendMessage(`Aliased main module ${options.name} to ${options.main}`);
		}

		output.end();
	});

	function writeDeclaration(declarationFile: ts.SourceFile) {
		var filename = declarationFile.fileName;
		var sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));

		if (declarationFile.externalModuleIndicator) {
			output.write('declare module \'' + sourceModuleId + '\' {' + eol + indent);

			var content = processTree(declarationFile, function (node) {
				if (node.kind === ts.SyntaxKind.ExternalModuleReference) {
					var expression = <ts.LiteralExpression> (<ts.ExternalModuleReference> node).expression;

					if (expression.text.charAt(0) === '.') {
						return ' require(\'' + pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text) + '\')';
					}
				}
				else if (node.kind === ts.SyntaxKind.DeclareKeyword) {
					return '';
				}
				else if (
					node.kind === ts.SyntaxKind.StringLiteral &&
					(node.parent.kind === ts.SyntaxKind.ExportDeclaration || node.parent.kind === ts.SyntaxKind.ImportDeclaration)
				) {
					var text = (<ts.StringLiteralTypeNode> node).text;
					if (text.charAt(0) === '.') {
						return ` '${pathUtil.join(pathUtil.dirname(sourceModuleId), text)}'`;
					}
				}
			});

			output.write(content.replace(nonEmptyLineStart, '$&' + indent));
			output.write(eol + '}' + eol);
		}
		else {
			output.write(declarationFile.text);
		}
	}
}
