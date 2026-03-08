import { FunctionDeclaration } from '@google/genai';
export declare const webSearchDeclaration: FunctionDeclaration;
export declare function webSearch({ query }: {
    query: string;
}): Promise<string>;
export declare const readWebpageDeclaration: FunctionDeclaration;
export declare function readWebpage({ url }: {
    url: string;
}): Promise<string>;
export declare const mouseClickDeclaration: FunctionDeclaration;
export declare function mouseClick(): Promise<string>;
export declare const keyboardTypeDeclaration: FunctionDeclaration;
export declare function keyboardType({ text }: {
    text: string;
}): Promise<string>;
