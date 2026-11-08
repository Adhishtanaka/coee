// The model loops, without vscode: fitting a prompt to the model's limit, and asking again once when a JSON reply
// has problems. lm.ts plugs in the real model; tests plug in a fake one.
import { buildRepairPrompt, parseJson } from './prompt';

/** A prompt, or a builder that fits its variable part (code, file excerpts) into `budget` characters. */
export type Prompt = string | ((budget: number) => string);

const CHARS_PER_TOKEN = 3; // ponytail: conservative guess for the first try; the real count corrects it

/** The prompt text that fits `limit` tokens: builders are re-run with a smaller budget until it does. */
export async function fitPrompt(prompt: Prompt, limit: number, count: (text: string) => Promise<number>, name = 'the model'): Promise<string> {
	if (typeof prompt === 'string') {
		if (await count(prompt) > limit) throw new Error(`This is too much code for ${name} at once (about ${limit} tokens fit). Select a smaller part.`);
		return prompt;
	}
	let budget = limit * CHARS_PER_TOKEN;
	for (let attempt = 0; attempt < 5; attempt++) {
		const text = prompt(Math.max(1000, budget));
		const used = await count(text);
		if (used <= limit) return text;
		budget = Math.floor(budget * (limit / used) * 0.9);
	}
	throw new Error(`Couldn't fit this into ${name}'s input limit. Select a smaller part, or pick a model with a bigger context (setting coee.modelFamily).`);
}

/**
 * A JSON reply turned into a value by `check`, which repairs what it can. What it can't fix goes back to the model
 * once, with the problems listed. A usable value after the retry is returned even if imperfect.
 * `send` gets the conversation so far (user, assistant, user, …) and returns the reply.
 */
export async function jsonLoop<T>(prompt: Prompt, send: (history: Prompt[]) => Promise<string>, check: (draft: unknown) => { value?: T; errors: string[] }, warn: (m: string) => void = () => {}): Promise<T> {
	const history: Prompt[] = [prompt];
	for (let attempt = 0; ; attempt++) {
		const reply = await send(history);
		let result: { value?: T; errors: string[] };
		try {
			result = check(parseJson(reply));
		} catch (e) {
			result = { errors: [`Reply was not valid JSON (${(e as Error).message})`] };
		}
		if (result.value !== undefined && !result.errors.length) return result.value;
		warn(`Model reply had problems (attempt ${attempt + 1}): ${result.errors.join('; ')}`);
		if (attempt === 1) {
			if (result.value !== undefined) return result.value; // usable, if not everything that was asked for
			throw new Error('The model\'s reply couldn\'t be used, even after a retry. Try again, or try another model (setting coee.modelFamily). Details are in Output → coee.');
		}
		history.push(reply, buildRepairPrompt(result.errors));
	}
}
