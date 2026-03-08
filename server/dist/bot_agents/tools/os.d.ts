import { FunctionDeclaration } from '@google/genai';
export declare const runCommandDeclaration: FunctionDeclaration;
export declare function runCommand({ command }: {
    command: string;
}): Promise<string>;
export declare const openApplicationDeclaration: FunctionDeclaration;
export declare function openApplication({ app_name_or_path }: {
    app_name_or_path: string;
}): Promise<string>;
export declare const closeApplicationDeclaration: FunctionDeclaration;
export declare function closeApplication({ process_name }: {
    process_name: string;
}): Promise<string>;
