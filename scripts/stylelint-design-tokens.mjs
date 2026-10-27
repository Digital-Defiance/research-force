import stylelint from 'stylelint';

const ruleName = 'researchforce/design-tokens';
const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (value) => `Use a design token instead of the raw value "${value}".`,
});
const wide = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'normal', 'auto', '0']);

export default stylelint.createPlugin(ruleName, (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkDecls((decl) => {
    const value = decl.value.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const property = decl.prop.toLowerCase();
    const rawDimension = /(?<![\w-])[-+]?(?:\d*\.)?\d+(?:px|r?em|ex|ch|cap|ic|lh|rlh|[sld]?v[whib]|vmin|vmax|cm|mm|in|pt|pc|q|%)(?![\w-])/i.test(value);
    const rawColour = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i.test(value);
    const withoutVars = value.replace(/var\(\s*--[\w-]+\s*\)/g, '').trim();
    const colourProperty = /(?:^|-)color$|^(?:background|fill|stroke|border(?:-(?:top|right|bottom|left))?)$/.test(property);
    const rawNamedColour = colourProperty && withoutVars && !/^(?:transparent|currentcolor|none|inherit|initial|unset|revert(?:-layer)?)$/i.test(withoutVars) && /\b[a-z]+\b/i.test(withoutVars.replace(/\b(?:solid|dashed|dotted|double)\b/g, ''));
    const fontProperty = /^(?:font(?:-family|-size|-weight|-stretch)?|line-height|letter-spacing|word-spacing)$/.test(property);
    const rawFont = fontProperty && withoutVars && !wide.has(withoutVars);
    const numericProperty = /^(?:(?:margin|padding|gap|inset)(?:-.*)?|(?:min-|max-)?(?:width|height|inline-size|block-size)|top|right|bottom|left|border(?:-.*)?(?:width|radius)|outline-width)$/.test(property);
    const rawUnitless = numericProperty && /(?<![\w-])(?:[1-9]\d*|0?\.\d+)(?![\w-])/.test(withoutVars);
    if (rawDimension || rawColour || rawNamedColour || rawFont || rawUnitless || property.startsWith('--')) {
      stylelint.utils.report({ ruleName, result, node: decl, message: messages.rejected(value) });
    }
  });
});
