import { FunctionDeclaration } from '@google/genai';
export declare const listFilesDeclaration: FunctionDeclaration;
export declare function listFiles({ directory_path }: {
    directory_path: string;
}): Promise<string>;
export declare const readFileContentDeclaration: FunctionDeclaration;
export declare function readFileContent({ file_path }: {
    file_path: string;
}): Promise<string>;
export declare const writeFileContentDeclaration: FunctionDeclaration;
export declare function writeFileContent({ file_path, content }: {
    file_path: string;
    content: string;
}): Promise<string>;
export declare const deleteFileDeclaration: FunctionDeclaration;
export declare function deleteFile({ file_path }: {
    file_path: string;
}): Promise<string>;
