const { Plugin } = require('../../../js/core/plugin-base.js');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// One pip requirement: a name, optional [extras], optional version specifiers. No shell characters.
const PIP_REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?((==|!=|>=|<=|~=|>|<)[A-Za-z0-9.*+_-]+(,(==|!=|>=|<=|~=|>|<)[A-Za-z0-9.*+_-]+)*)?$/;

class CodeExecutorPlugin extends Plugin {

    getTools() {
        return [
            { type: 'function', function: { name: 'execute_code', description: 'Run Python code that you write. Good for all kinds of programming tasks, such as data processing, file operations, network requests and calculations', parameters: { type: 'object', properties: { code: { type: 'string', description: 'The Python code to run' }, description: { type: 'string', description: 'What the code does (optional)' } }, required: ['code'] } } },
            { type: 'function', function: { name: 'install_packages', description: 'Install Python packages into the conda environment', parameters: { type: 'object', properties: { packages: { type: 'string', description: "Package names to install, separated by spaces, for example: 'requests pandas numpy'" } }, required: ['packages'] } } }
        ];
    }

    async executeTool(name, params) {
        if (name === 'execute_code') return await this._executeCode(params);
        if (name === 'install_packages') return await this._installPackages(params);
        throw new Error(`[code-executor] Unsupported tool: ${name}`);
    }

    async _executeCode({ code, description = 'Run AI-generated code' }) {
        if (!code?.trim()) throw new Error('The code must not be empty');

        return new Promise((resolve, reject) => {
            const timestamp = Date.now();
            const tempScriptPath = path.join(__dirname, `temp_ai_code_${timestamp}.py`);

            const wrappedCode = `# -*- coding: utf-8 -*-
import sys, json, traceback, io, subprocess, os
from contextlib import redirect_stdout, redirect_stderr

def start_detached(command):
    if os.name == 'nt':
        subprocess.Popen(command, shell=True, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    else:
        subprocess.Popen(command, shell=True, start_new_session=True)
    print(f"Started program: {command}")

def main():
${code.split('\n').map(line => `    ${line}`).join('\n')}

if __name__ == '__main__':
    try:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            main()
        print(json.dumps({"success": True, "stdout": out.getvalue(), "stderr": err.getvalue(), "description": os.environ.get("MYNEURO_CODE_DESCRIPTION", "")}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc(), "description": os.environ.get("MYNEURO_CODE_DESCRIPTION", "")}, ensure_ascii=False))
`;
            fs.writeFileSync(tempScriptPath, wrappedCode);

            const isWindows = process.platform === 'win32';
            const command = isWindows
                ? `call conda activate my-neuro && python "${tempScriptPath}"`
                : `source activate my-neuro && python "${tempScriptPath}"`;

            exec(command, { timeout: 60000, shell: isWindows ? 'cmd.exe' : '/bin/bash', env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1', MYNEURO_CODE_DESCRIPTION: String(description) } }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempScriptPath); } catch (e) {}
                if (error) return reject(new Error(`Code execution failed: ${error.message}`));
                try {
                    const result = JSON.parse(stdout);
                    if (result.success) {
                        let output = `✅ ${result.description}\n`;
                        if (result.stdout) output += `\n📄 Output:\n${result.stdout}`;
                        if (result.stderr) output += `\n⚠️ Warnings:\n${result.stderr}`;
                        resolve(output);
                    } else {
                        resolve(`❌ The code raised an error: ${result.error}\n\n🔍 Error details:\n${result.traceback}`);
                    }
                } catch { resolve(`✅ Code finished\n\n📄 Raw output:\n${stdout}`); }
            });
        });
    }

    async _installPackages({ packages }) {
        if (!packages?.trim()) throw new Error('The package names must not be empty');

        // The package list goes into a shell command, so accept only plain pip requirements
        // ("requests", "numpy>=1.26", "uvicorn[standard]") and quote each one.
        // Before, "requests & del /q somefile" also ran the second command.
        const requirements = packages.trim().split(/\s+/);
        const invalid = requirements.filter(requirement => !PIP_REQUIREMENT.test(requirement));
        if (invalid.length > 0) {
            throw new Error(`Invalid package name: ${invalid.join(' ')}. Use names like "requests" or "numpy>=1.26".`);
        }
        const quoted = requirements.map(requirement => `"${requirement}"`).join(' ');

        return new Promise((resolve, reject) => {
            const isWindows = process.platform === 'win32';
            const command = isWindows
                ? `call conda activate my-neuro && pip install ${quoted}`
                : `source activate my-neuro && pip install ${quoted}`;

            exec(command, { timeout: 300000, shell: isWindows ? 'cmd.exe' : '/bin/bash', env: { ...process.env, CONDA_DLL_SEARCH_MODIFICATION_ENABLE: '1' } }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`Failed to install the packages: ${error.message}`));
                resolve(`✅ Installed packages: ${packages}\n\n📄 Install log:\n${stdout}${stderr}`);
            });
        });
    }
}

module.exports = CodeExecutorPlugin;
