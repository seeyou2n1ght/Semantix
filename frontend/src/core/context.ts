import { Editor, MarkdownView } from 'obsidian';
import { cleanMarkdown } from '../utils/markdown';
import { RadarContext } from '../api/types';

export type ContextTransitionType =
    | 'NEW_FILE'
    | 'NEW_HEADING'
    | 'NEW_PARAGRAPH'
    | 'SAME_PARAGRAPH'
    | 'NOTE_MODE';

export interface ContextSnapshot {
    transitionType: ContextTransitionType;
    context: RadarContext;
    contextId: string;
    cleanedText: string;
    paragraphLine: number;
}

export class ContextEngine {
    private lastFilePath: string | null = null;
    private lastHeading: string | null = null;
    private lastParagraphLine: number | null = null;

    /**
     * 重置状态（例如关闭文件或失焦）
     */
    public reset() {
        this.lastFilePath = null;
        this.lastHeading = null;
        this.lastParagraphLine = null;
    }

    /**
     * 提取当前 Focus 上下文并计算跃迁类型
     */
    public captureFocusSnapshot(editor: Editor, view: MarkdownView): ContextSnapshot | null {
        const file = view.file;
        if (!file || file.extension !== 'md') return null;

        const cursor = editor.getCursor();
        const paragraphInfo = this.extractParagraph(editor, cursor.line);
        const cleanedText = cleanMarkdown(paragraphInfo.text).trim();
        if (cleanedText.length < 3) return null;

        const heading = this.findClosestHeading(editor, cursor.line);
        const filePath = file.path;

        let transitionType: ContextTransitionType = 'SAME_PARAGRAPH';

        if (this.lastFilePath !== filePath) {
            transitionType = 'NEW_FILE';
        } else if (this.lastHeading !== heading) {
            transitionType = 'NEW_HEADING';
        } else if (this.lastParagraphLine !== paragraphInfo.startLine) {
            transitionType = 'NEW_PARAGRAPH';
        } else {
            transitionType = 'SAME_PARAGRAPH';
        }

        this.lastFilePath = filePath;
        this.lastHeading = heading;
        this.lastParagraphLine = paragraphInfo.startLine;

        // 生成稳定的前端 context_id
        const safeHeading = (heading || 'root').replace(/[^\w\u4e00-\u9fa5]/g, '_');
        const contextId = `${filePath}#${safeHeading}#L${paragraphInfo.startLine}`;

        const metadata = view.app.metadataCache.getFileCache(file);
        const tags = metadata?.tags?.map(t => t.tag) || [];
        const resolved = view.app.metadataCache.resolvedLinks[filePath];
        const links = resolved ? Object.keys(resolved) : [];

        const context: RadarContext = {
            path: filePath,
            title: file.basename,
            heading: heading || undefined,
            text: cleanedText,
            tags: [...new Set(tags)],
            links,
            scope: 'focus'
        };

        return {
            transitionType,
            context,
            contextId,
            cleanedText,
            paragraphLine: paragraphInfo.startLine
        };
    }

    /**
     * 提取全篇笔记上下文 (Note Mode)
     */
    public captureNoteSnapshot(view: MarkdownView): ContextSnapshot | null {
        const file = view.file;
        if (!file || file.extension !== 'md') return null;

        const fullText = view.editor.getValue();
        const cleanedText = cleanMarkdown(fullText).trim();
        if (cleanedText.length < 5) return null;

        const filePath = file.path;
        const contextId = `${filePath}#full_note`;

        const metadata = view.app.metadataCache.getFileCache(file);
        const tags = metadata?.tags?.map(t => t.tag) || [];
        const resolved = view.app.metadataCache.resolvedLinks[filePath];
        const links = resolved ? Object.keys(resolved) : [];

        const context: RadarContext = {
            path: filePath,
            title: file.basename,
            text: cleanedText,
            tags: [...new Set(tags)],
            links,
            scope: 'note'
        };

        return {
            transitionType: 'NOTE_MODE',
            context,
            contextId,
            cleanedText,
            paragraphLine: 0
        };
    }

    /**
     * 提取光标所在段落（向上向下寻找空行边界）
     */
    private extractParagraph(editor: Editor, cursorLine: number): { text: string; startLine: number; endLine: number } {
        let text = editor.getLine(cursorLine);
        let startLine = cursorLine;
        let endLine = cursorLine;

        // 向上寻找段落起始
        let curr = cursorLine - 1;
        while (curr >= 0) {
            const line = editor.getLine(curr);
            if (line.trim() === '') break;
            text = line + '\n' + text;
            startLine = curr;
            curr--;
        }

        // 向下寻找段落结束
        curr = cursorLine + 1;
        const total = editor.lineCount();
        while (curr < total) {
            const line = editor.getLine(curr);
            if (line.trim() === '') break;
            text = text + '\n' + line;
            endLine = curr;
            curr++;
        }

        return { text, startLine, endLine };
    }

    /**
     * 向上寻找离光标最近的 Heading
     */
    private findClosestHeading(editor: Editor, cursorLine: number): string | null {
        for (let l = cursorLine; l >= 0; l--) {
            const line = editor.getLine(l).trim();
            if (line.startsWith('#')) {
                const match = line.match(/^#+\s+(.+)$/);
                if (match && match[1]) return match[1].trim();
            }
        }
        return null;
    }
}
