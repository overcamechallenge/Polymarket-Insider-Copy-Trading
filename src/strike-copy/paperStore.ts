import fs from 'node:fs';
import path from 'node:path';
import { PaperPortfolio, PaperPortfolioPersisted } from '../lib/paperPortfolio';
import { STRIKE_COPY_PAPER_START_USD } from './config';

const DEFAULT_FILE = path.join(process.cwd(), 'strike-copy-data', 'paper-portfolio.json');

const getPaperPath = (): string => process.env.STRIKE_COPY_PAPER_FILE?.trim() || DEFAULT_FILE;

export const loadPaper = (): PaperPortfolio => {
    const f = getPaperPath();
    if (!fs.existsSync(f)) return new PaperPortfolio(STRIKE_COPY_PAPER_START_USD);
    try {
        return PaperPortfolio.fromPersisted(JSON.parse(fs.readFileSync(f, 'utf8')) as PaperPortfolioPersisted);
    } catch {
        return new PaperPortfolio(STRIKE_COPY_PAPER_START_USD);
    }
};

export const savePaper = (p: PaperPortfolio): void => {
    const f = getPaperPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(p.toPersisted(), null, 2));
};
