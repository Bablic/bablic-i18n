
export interface BaseOptions {
    verbose?: boolean;
}

export interface InitOptions extends BaseOptions {
    name: string;
    originalLocale: string;
}
