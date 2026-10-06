import type { Child, Component, JsxValue } from './core.ts';
export { jsx, jsxs, Fragment, h } from './core.ts';
export { jsx as jsxDEV } from './core.ts';
type ElProps = {
    children?: Child;
    [attr: string]: unknown;
};
export declare namespace JSX {
    type Element = JsxValue;
    type ElementType = string | Component;
    interface ElementChildrenAttribute {
        children: {};
    }
    interface IntrinsicAttributes {
        key?: string | number;
    }
    interface IntrinsicElements {
        ol: ElProps;
        ul: ElProps;
        li: ElProps;
        pre: ElProps;
        code: ElProps;
        b: ElProps;
        i: ElProps;
        p: ElProps;
        h1: ElProps;
        h2: ElProps;
        h3: ElProps;
        h4: ElProps;
        h5: ElProps;
        h6: ElProps;
        br: {
            key?: string | number;
        };
    }
}
