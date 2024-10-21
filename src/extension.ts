import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface ModuleInfoType {
	result: any; 
	module: string;
	parameters: ParamInfo[];
	ports: PortInfo[];
}

interface CommandConfig {
	executable: string;
	params: string[];
	paramSetting: string;
	passingParam: boolean;
}

interface PortInfo {
	identifier: string;
	preString: string;
	hasType: boolean;
}

interface ParamInfo {
	identifier: string;
	paramString: string;
}

function generate_instance(origin_string: string, token_obj: any, passingOn: boolean=false): ModuleInfoType {
    let result = '';
    function traverse(node: any, path: string[], parameters: ParamInfo[], ports: PortInfo[], moduleNameRef: any, hasTypeRef: any) {
        if (!node || !node.tag) return;

        path.push(node.tag);

        if (node.tag === 'module') {
            const siblings = node.parent ? node.parent.children : [];
            const moduleIndex = siblings.indexOf(node);
            if (moduleIndex !== -1) {
                for (let i = moduleIndex + 1; i < siblings.length; i++) {
                    const sibling = siblings[i];
                    if (sibling && sibling.tag === 'SymbolIdentifier') {
                        moduleNameRef.name = sibling.text;
                        break;
                    }
                }
            }
        }

        if (node.tag === 'SymbolIdentifier' && !path.includes('kDataType') && path.includes('kFormalParameterListDeclaration') && path.includes('kParamDeclaration') && (path.includes('kParamType') || path.includes('kTypeAssignment'))) {
			let param = {
				identifier: '',
				paramString: ''
			};
			param.identifier = node.text;
			let lineStart = origin_string.lastIndexOf('\n', node.start - 1) + 1; 
			let lineEnd= origin_string.indexOf('\n', node.start + 1) + 1; 
			let paramString = origin_string.substring(lineStart, lineEnd).trim(); 
			paramString = paramString.replace(/,$/, '');
			param.paramString = paramString;
			parameters.push(param);
        }

        if (path.includes('kPortDeclarationList') && path.includes('kPortDeclaration')) {
			if (!path.includes('kDataType')) {
				if (node.tag === 'SymbolIdentifier' && path.includes('kUnqualifiedId')) {
					let port = {
						identifier: '',
						preString: '',
						hasType: false
					};
					port.identifier = node.text;
					let lineStart = origin_string.lastIndexOf('\n', node.start - 1) + 1; 
					let dataTypeString = origin_string.substring(lineStart, node.start).trim(); 
					port.preString = dataTypeString;
					port.hasType = hasTypeRef.hasType;
					ports.push(port);
					hasTypeRef.hasType = false;
				}
			} else if(path.includes('kDataTypePrimitive')) {
				hasTypeRef.hasType = true;
			}
        }

        if (node.children) {
            for (const child of node.children) {
                if (child) { 
                    child.parent = node; 
                    traverse(child, [...path], parameters, ports, moduleNameRef, hasTypeRef);
                }
            }
        }

        path.pop();
    }

	let moduleNameRef = { name: '' }; 
	let parameters: ParamInfo[] = [];
	let ports: PortInfo[] = [];
	let hasTypeRef = {hasType: false};

    for (const filePath in token_obj) {
        const tree = token_obj[filePath].tree;
        traverse(tree, [], parameters, ports, moduleNameRef, hasTypeRef);

        const maxParamLength = Math.max(...parameters.map(param => param.identifier.length));
        const maxPortLength = Math.max(...ports.map(port => port.identifier.length));

		const instParamsBefore = parameters.length ? ` #(\n` : '';
		const instParamsAfter = parameters.length ? `    )` : '';
        result += `    ${moduleNameRef.name}`+instParamsBefore;
        parameters.forEach((param, index) => {
            const comma = index === parameters.length - 1 ? '' : ',';
            result += `        .${param.identifier.padEnd(maxParamLength)} (${passingOn ? param.identifier.padEnd(maxParamLength) : ''})${comma}\n`;
        });
        result += instParamsAfter + ` i_${moduleNameRef.name} (\n`;
        ports.forEach((port, index) => {
            const comma = index === ports.length - 1 ? ' ' : ',';
            result += `        .${port.identifier.padEnd(maxPortLength)} (${passingOn ? port.identifier.padEnd(maxPortLength) : ''})${comma} //${port.preString}\n`;
        });
        result += `    );\n`;
		break;
    }
    
    return {
		result,
		module: moduleNameRef.name,
		parameters,
		ports
	};
}

const executableTable: Record<string, CommandConfig> = {
	'instance': {executable: 'veribleSyntaxPath', params: ['--printtree', '--export_json'], paramSetting: 'syntaxArgs', passingParam: false},
	'testbench': {executable: 'veribleSyntaxPath', params: ['--printtree', '--export_json'], paramSetting: 'syntaxArgs', passingParam: true}
};

function run_cmd(config: vscode.WorkspaceConfiguration, mode: string, filePath: string, originString: string, callback: Function) {
	const {executable, params, paramSetting, passingParam} = executableTable[mode];
	const veribleSyntaxPath = config.get<string>(executable)?.replaceAll('\\\\', '/').replaceAll('\\', '/') || '';
	const syntaxArgs = (config.get<string>(paramSetting) || '').split(' ').concat(params.concat(filePath.replaceAll('\\\\', '/').replaceAll('\\', '/'))).filter(e => e);

	execFile(veribleSyntaxPath, syntaxArgs, (error, stdout, stderr) => {
		if (error) {
			vscode.window.showErrorMessage(`Error: ${error.message}`);
			return;
		}
		if (stderr) {
			vscode.window.showErrorMessage(`Stderr: ${stderr}`);
			return;
		}
		try {
			const jsonObject = JSON.parse(stdout);
			const instanceInfo = generate_instance(originString, jsonObject, passingParam);
			callback(instanceInfo);
		} catch (parseError) {
			// @ts-ignore
			vscode.window.showErrorMessage(`Error: ${parseError.message}`);
		}
	});
}
function dirToType(ports: PortInfo[]) {
	let result = '';
	for (const p of ports) {
		let line = '';
		const noStore = p.preString.replaceAll('wire', '');
		if (p.hasType) {
			line += `${noStore.replaceAll('input', '').replaceAll('output', '').replaceAll('inout', '')}`;
		} else {
			line += `${noStore.replaceAll('input', 'reg').replaceAll('output', 'wire').replaceAll('inout', 'reg')}`;
		}
		line += ` ${p.identifier};`;
		result += `${line.trim()}\n\t`
	}
	return result;
}

export function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('VeriToolbox');
    const generateInstanceToClipboard = vscode.commands.registerCommand('VeriToolbox.generateInstanceToClipboard', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor found');
            return;
        }

        const document = editor.document;
        const filePath = document.fileName;
        const originString = document.getText();
		run_cmd(config, 'instance', filePath, originString, (info: ModuleInfoType) => {
			vscode.env.clipboard.writeText(info.result).then(() => {
				vscode.window.showInformationMessage('Instance copied to clipboard');
			});
		});
        
    });

    const insertInstanceFromFile = vscode.commands.registerCommand('VeriToolbox.insertInstanceFromFile', async () => {
        const fileUri = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Verilog/SystemVerilog Files': ['v', 'sv'] } });
        if (fileUri && fileUri[0]) {
            const filePath = fileUri[0].fsPath;
            const originString = fs.readFileSync(filePath, 'utf-8');

			run_cmd(config, 'instance', filePath, originString, (info: ModuleInfoType) => {
				const editor = vscode.window.activeTextEditor;
				if (editor) {
					editor.edit(editBuilder => {
						editBuilder.insert(editor.selection.active, info.result);
					});
				}
			});
        }
    });


	const generateTestbenchToClipboard = vscode.commands.registerCommand('VeriToolbox.generateTestbenchToClipboard', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor found');
            return;
        }

        const document = editor.document;
        const filePath = document.fileName;
        const originString = document.getText();
		run_cmd(config, 'testbench', filePath, originString, (info: ModuleInfoType) => {
			let result = `\`timescale 1ns / 1ns
module tb_${info.module};

	parameter PERIOD  = 10;

	reg clk, rst_n;
	${info.parameters.map((p, index) => `${p.paramString};`).join('\n\t')}		
	${dirToType(info.ports)}	

	initial begin
        $dumpfile("tb_${info.module}.vcd");
        $dumpvars(0, tb_${info.module});
    end

	initial begin
		clk <= 0;
		forever #(PERIOD / 2) clk <= ~clk;
	end

	initial begin
		rst_n <= 0;
		#(PERIOD*2) rst_n <= 1;
	end

${info.result}
		
	initial begin
		$finish;
	end
endmodule
			`;
			vscode.env.clipboard.writeText(result).then(() => {
				vscode.window.showInformationMessage('Instance copied to clipboard');
			});
		});
        
    });

    context.subscriptions.push(generateInstanceToClipboard);
    context.subscriptions.push(insertInstanceFromFile);

	context.subscriptions.push(generateTestbenchToClipboard);
}

export function deactivate() {}
