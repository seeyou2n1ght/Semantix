import { moment } from "obsidian";
import en from "./locales/en";
import zhCn from "./locales/zh-cn";

const localeMap: { [key: string]: any } = {
    en,
    "zh-cn": zhCn,
};

/**
 * 获取翻译字符串
 * @param key 翻译键名
 * @param params 可选的替换参数（如 {version: "1.0.0"}）
 * @returns 翻译后的字符串
 */
export function t(key: keyof typeof en, params?: { [key: string]: string | number }): string {
    const lang = moment.locale();
    const currentLocale = localeMap[lang] || localeMap["en"];
    
    let text = currentLocale[key] || en[key] || key;
    
    if (params) {
        Object.keys(params).forEach((paramKey) => {
            text = text.replace(`{{${paramKey}}}`, String(params[paramKey]));
        });
    }
    
    return text;
}
