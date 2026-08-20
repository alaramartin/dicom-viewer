// Bundles src/extension.ts (and everything it pulls in from node_modules)
// into a single dist/extension.js, so the packaged VSIX doesn't need to ship
// node_modules at all. `vscode` is the one thing that must stay external —
// it isn't a real package, VS Code injects it at runtime.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// .vscode/tasks.json's problem matcher watches stdout for these exact lines
// to know when a background watch build starts/finishes — without them, the
// default build task never reports "done" and every F5 launch stalls
// waiting on it.
const watchLoggerPlugin = {
	name: 'watch-logger',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd(() => {
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'info',
		plugins: [watchLoggerPlugin],
	});

	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
