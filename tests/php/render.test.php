<?php
/**
 * The render door's payload gate (R55).
 *
 * do_shortcode()'s output is echoed unescaped, and this door carries no credential beyond the
 * guard — so on any guarded dev site anyone who can reach it could otherwise run any registered
 * shortcode with attacker-chosen attributes, and have arbitrary HTML reflected back. The gate is
 * the shape the journey actually sends, and nothing else.
 */
require __DIR__ . '/assert.php';
require __DIR__ . '/../../mu-plugin/src/render.php';

// What src/suite/rendered-surface.ts actually sends: exactly [tag].
wpj_assert('a bare shortcode tag is allowed', true, wpj_render_payload_allowed('[wpj_fixture]'));
wpj_assert('digits, underscores and hyphens are allowed in a tag', true, wpj_render_payload_allowed('[acme_2-x]'));

// Everything else is refused.
wpj_assert('a script tag is refused', false, wpj_render_payload_allowed('<script>alert(1)</script>'));
wpj_assert('a shortcode carrying attributes is refused', false, wpj_render_payload_allowed('[acme a="<img onerror=x>"]'));
wpj_assert('markup after a valid tag is refused', false, wpj_render_payload_allowed('[acme]<script>alert(1)</script>'));
wpj_assert('markup before a valid tag is refused', false, wpj_render_payload_allowed('<b>[acme]'));

// $ in PHP matches before a trailing newline, so an anchor of ^...$ would let this through and
// the whole gate would be one newline wide. \A...\z is what closes it.
wpj_assert('a newline then markup after a valid tag is refused', false, wpj_render_payload_allowed("[acme]\n<script>alert(1)</script>"));
wpj_assert('a bare trailing newline is refused', false, wpj_render_payload_allowed("[acme]\n"));

wpj_assert('an empty payload is refused', false, wpj_render_payload_allowed(''));
wpj_assert('a bare word is refused', false, wpj_render_payload_allowed('acme'));
wpj_assert('an unclosed bracket is refused', false, wpj_render_payload_allowed('[acme'));
wpj_assert('an empty tag is refused', false, wpj_render_payload_allowed('[]'));
wpj_assert('two shortcodes at once are refused', false, wpj_render_payload_allowed('[acme][other]'));
wpj_assert('a non-string payload is refused rather than cast into a warning', false, wpj_render_payload_allowed(array()));

// The marker says whether do_shortcode() changed its input. Only the agent knows that for
// certain: a shortcode's own output may quote its tag, so the runner cannot tell from the text.
wpj_assert('an expanded tag is marked expanded', '<div data-wpj-render="1" data-wpj-expanded="1"><p>hi</p></div>', wpj_render_wrap('[acme]', '<p>hi</p>'));
wpj_assert('output that quotes its own tag is still expanded', '<div data-wpj-render="1" data-wpj-expanded="1">[acme] needs a url.</div>', wpj_render_wrap('[acme]', '[acme] needs a url.'));
wpj_assert('an unchanged tag is marked not expanded', '<div data-wpj-render="1" data-wpj-expanded="0">[acme]</div>', wpj_render_wrap('[acme]', '[acme]'));

// The block door (R57): a block name as core's registry accepts one, and nothing else.
wpj_assert('a namespaced block name is allowed', true, wpj_render_block_payload_allowed('wpj-fixture/hello'));
wpj_assert('digits are allowed in both halves', true, wpj_render_block_payload_allowed('acme2/block-3'));
wpj_assert('a name without a namespace is refused', false, wpj_render_block_payload_allowed('hello'));
wpj_assert('upper case is refused, as core refuses it', false, wpj_render_block_payload_allowed('Acme/hello'));
wpj_assert('markup is refused', false, wpj_render_block_payload_allowed('acme/<script>'));
wpj_assert('a trailing newline is refused', false, wpj_render_block_payload_allowed("acme/hello\n"));
wpj_assert('a third segment is refused', false, wpj_render_block_payload_allowed('acme/a/b'));
wpj_assert('a non-string is refused', false, wpj_render_block_payload_allowed(array()));

wpj_assert('a registered dynamic block is marked so', '<div data-wpj-render-block="1" data-wpj-registered="1" data-wpj-dynamic="1"><p>hi</p></div>', wpj_render_block_wrap(true, true, '<p>hi</p>'));
wpj_assert('an unregistered block is marked so', '<div data-wpj-render-block="1" data-wpj-registered="0" data-wpj-dynamic="0"></div>', wpj_render_block_wrap(false, false, ''));

wpj_assert_exit();
