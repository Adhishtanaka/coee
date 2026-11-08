import * as vscode from 'vscode';
import { buildRepairPrompt, parseJson } from './prompt';

export const log = vscode.window.createOutputChannel('coee', { log: true });

export const isCancel = (err: unknown) => err instanceof vscode.CancellationError || (err instanceof Error && err.name === 'Canceled');

async function pickModel(): Promise<vscode.LanguageModelChat> {
	const family = vscode.workspace.getConfiguration('coee').get<string>('modelFamily', '').trim();
	const model = (await vscode.lm.selectChatModels(family ? { family } : undefined))[0]
		?? (family ? (await vscode.lm.selectChatModels())[0] : undefined);
	if (!model) throw new Error('No chat model is available. Install and sign in to GitHub Copilot (or another language model provider), then try again.');
	if (family && model.family !== family) log.warn(`Model family "${family}" not found, using ${model.name}`);
	return model;
}

function friendly(err: unknown): Error {
	if (err instanceof Error && /token limit|too long|context length|maximum context/i.test(err.message)) return new Error('That was more code than the model accepts at once. Select a smaller part, or pick a model with a bigger context (setting coee.modelFamily).');
	if (err instanceof vscode.LanguageModelError) {
		log.error(`LanguageModelError ${err.code}: ${err.message}`);
		if (err.code === vscode.LanguageModelError.NoPermissions.name) return new Error('coee needs permission to use the language model. Run the command again and choose Allow.');
		if (err.code === vscode.LanguageModelError.Blocked.name) return new Error('The language model is limiting requests right now. Wait a moment and try again.');
		if (err.code === vscode.LanguageModelError.NotFound.name) return new Error('The chosen language model is no longer available. Check the coee.modelFamily setting.');
	}
	return err instanceof Error ? err : new Error(String(err));
}

/**
 * A prompt, or a builder that fits its variable part (code, file excerpts) into `budget` characters.
 * Builders are re-run with a smaller budget until the prompt fits the chosen model's input limit.
 */
export type Prompt = string | ((budget: number) => string);

const CHARS_PER_TOKEN = 3; // ponytail: conservative guess for the first try; countTokens corrects it

async function fit(model: vscode.LanguageModelChat, prompt: Prompt, token: vscode.CancellationToken): Promise<string> {
	const limit = Math.floor(model.maxInputTokens * 0.85); // headroom for the system side and tokenizer drift
	if (typeof prompt === 'string') {
		if (await model.countTokens(prompt, token) > limit) throw new Error(`This is too much code for ${model.name} at once (about ${limit} tokens fit). Select a smaller part.`);
		return prompt;
	}
	let budget = limit * CHARS_PER_TOKEN;
	for (let attempt = 0; attempt < 5; attempt++) {
		const text = prompt(Math.max(1000, budget));
		const used = await model.countTokens(text, token);
		if (used <= limit) return text;
		log.info(`prompt was ${used} tokens, limit ${limit}; shrinking`);
		budget = Math.floor(budget * (limit / used) * 0.9);
	}
	throw new Error(`Couldn't fit this into ${model.name}'s input limit. Select a smaller part, or pick a model with a bigger context (setting coee.modelFamily).`);
}

/** One request at a time per instance: starting a new one cancels the last. */
export class Lm {
	private cts?: vscode.CancellationTokenSource;

	constructor(private readonly purpose: string) {}

	cancel() { this.cts?.cancel(); }

	/** Stream a reply to one prompt. */
	ask(prompt: Prompt, onChunk?: (t: string) => void, outer?: vscode.CancellationToken): Promise<string> {
		return this.request([prompt], onChunk, outer);
	}

	/** `history` alternates user/assistant turns, starting with the user; only the first may be a builder. */
	private async request(history: Prompt[], onChunk?: (t: string) => void, outer?: vscode.CancellationToken): Promise<string> {
		this.cancel();
		const cts = this.cts = new vscode.CancellationTokenSource();
		const sub = outer?.onCancellationRequested(() => cts.cancel());
		try {
			const model = await pickModel();
			const first = await fit(model, history[0], cts.token);
			if (typeof history[0] !== 'string') history[0] = first; // later repair turns resend the same text
			const messages = history.map((t, i) => i % 2 ? vscode.LanguageModelChatMessage.Assistant(t as string) : vscode.LanguageModelChatMessage.User(t as string));
			log.info(`→ ${model.name}: ${this.purpose}`);
			const res = await model.sendRequest(messages, { justification: this.purpose }, cts.token);
			let text = '';
			for await (const chunk of res.text) {
				if (cts.token.isCancellationRequested) throw new vscode.CancellationError();
				text += chunk;
				onChunk?.(chunk);
			}
			return text;
		} catch (err) {
			if (cts.token.isCancellationRequested) throw new vscode.CancellationError();
			throw friendly(err);
		} finally {
			sub?.dispose();
			if (this.cts === cts) this.cts = undefined;
			cts.dispose();
		}
	}

	/** A JSON reply turned into a value by `check`, which repairs what it can. What it can't fix goes back to the model once. */
	async json<T>(prompt: Prompt, check: (draft: unknown) => { value?: T; errors: string[] }, token?: vscode.CancellationToken): Promise<T> {
		const history: Prompt[] = [prompt];
		for (let attempt = 0; ; attempt++) {
			const reply = await this.request(history, undefined, token);
			let result: { value?: T; errors: string[] };
			try {
				result = check(parseJson(reply));
			} catch (e) {
				result = { errors: [`Reply was not valid JSON (${(e as Error).message})`] };
			}
			if (result.value !== undefined && !result.errors.length) return result.value;
			log.warn(`Model reply had problems (attempt ${attempt + 1}): ${result.errors.join('; ')}`);
			if (attempt === 1) {
				log.error(reply);
				if (result.value !== undefined) return result.value; // usable, if not everything that was asked for
				throw new Error('The model\'s reply couldn\'t be turned into a walkthrough, even after a retry. Try again, or try another model (setting coee.modelFamily). Details are in Output → coee.');
			}
			history.push(reply, buildRepairPrompt(result.errors));
		}
	}
}
