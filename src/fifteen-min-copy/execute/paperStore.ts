import fs from 'node:fs';
import path from 'node:path';
import { PaperPortfolio, PaperPortfolioPersisted } from '../../lib/paperPortfolio';
import { FIFTEEN_MIN_PAPER_START_USD } from '../config';

const DEFAULT_FILE = path.join(process.cwd(), 'fifteen-min-copy-data', 'paper-portfolio.json');

export const getPaperPortfolioPath = (): string =>
    process.env.FIFTEEN_MIN_PAPER_FILE?.trim() || DEFAULT_FILE;

export const loadPaperPortfolio = (): PaperPortfolio => {
    const filePath = getPaperPortfolioPath();
    if (!fs.existsSync(filePath)) {
        return new PaperPortfolio(FIFTEEN_MIN_PAPER_START_USD);
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw) as PaperPortfolioPersisted;
        return PaperPortfolio.fromPersisted(data);
    } catch {
        return new PaperPortfolio(FIFTEEN_MIN_PAPER_START_USD);
    }
};

export const savePaperPortfolio = (portfolio: PaperPortfolio): string => {
    const filePath = getPaperPortfolioPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(portfolio.toPersisted(), null, 2));
    return filePath;
};
