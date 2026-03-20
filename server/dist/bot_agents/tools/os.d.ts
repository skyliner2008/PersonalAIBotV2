import { FunctionDeclaration } from '@google/genai';
export declare const runCommandDeclaration: FunctionDeclaration;
export declare function runCommand({ command }: {
    command: string;
}, options?: {
    chatId?: string;
}): Promise<string>;
export declare const openApplicationDeclaration: FunctionDeclaration;
export declare function openApplication({ app_name_or_path }: {
    app_name_or_path: string;
}): Promise<string>;
export declare const closeApplicationDeclaration: FunctionDeclaration;
export declare function closeApplication({ process_name }: {
    process_name: string;
}): Promise<string>;
export declare const runPythonDeclaration: FunctionDeclaration;
export declare function runPython({ code }: {
    code: string;
}): Promise<string>;
export declare const systemInfoDeclaration: FunctionDeclaration;
export declare function systemInfo(): string;
export declare const screenshotDesktopDeclaration: FunctionDeclaration;
export declare function screenshotDesktop({ save_path }: {
    save_path?: string;
}): Promise<string>;
export declare const clipboardReadDeclaration: FunctionDeclaration;
export declare function clipboardRead(): Promise<string>;
export declare const clipboardWriteDeclaration: FunctionDeclaration;
export declare function clipboardWrite({ text }: {
    text: string;
}): Promise<string>;
