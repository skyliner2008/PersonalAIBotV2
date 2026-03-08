import { FunctionDeclaration } from '@google/genai';
export declare const browserNavigateDeclaration: FunctionDeclaration;
export declare function browserNavigate({ url }: {
    url: string;
}): Promise<string>;
export declare const browserClickDeclaration: FunctionDeclaration;
export declare function browserClick({ selector }: {
    selector: string;
}): Promise<string>;
export declare const browserTypeDeclaration: FunctionDeclaration;
export declare function browserType({ selector, text }: {
    selector: string;
    text: string;
}): Promise<string>;
export declare const browserCloseDeclaration: FunctionDeclaration;
export declare function browserClose(): Promise<string>;
