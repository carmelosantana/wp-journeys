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

// Every tag core itself accepts (wp-includes/shortcodes.php:75 forbids only <>&/[] controls,
// whitespace and =). Refusing a legal registration made the marker go missing, which the runner
// reports as a defect of the plugin under test.
wpj_assert('a dotted tag is allowed', true, wpj_render_payload_allowed('[my.tag]'));
wpj_assert('punctuation core allows is allowed', true, wpj_render_payload_allowed('[tag!]'));
wpj_assert('a non-ASCII tag is allowed', true, wpj_render_payload_allowed("[caf\xc3\xa9]"));

// Everything else is refused.
wpj_assert('an ampersand is refused, as core refuses it', false, wpj_render_payload_allowed('[a&b]'));
wpj_assert('a slash is refused, as core refuses it', false, wpj_render_payload_allowed('[a/b]'));
wpj_assert('an equals sign is refused, so no attribute can ride along', false, wpj_render_payload_allowed('[a=b]'));
wpj_assert('a tab is refused, so no attribute can ride along', false, wpj_render_payload_allowed("[a\tb]"));
wpj_assert('a NUL is refused', false, wpj_render_payload_allowed("[a\0b]"));
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

// The render doors' credential: a stateless HMAC bound to the door, the payload and an expiry.
// The secret below is a dummy used only by the tests; it is not any site's secret.
$secret = 'dummy-vector-secret-not-real-0123';
$now = 1700000000;
$exp = 1700000300;

// THE SHARED VECTOR. tests/agent-render.test.ts asserts the same inputs give the same hex in
// TypeScript, which is what pins the two computations to each other.
$vector = '6510d389cb84d523b408e3ec71d45eafef56843ce4008ea63a3f0924a0526ed3';
wpj_assert('the shared test vector signs to the pinned hex', $vector, wpj_render_signature('wpj_render', '[wpj_fixture]', (string) $exp, $secret));
wpj_assert('a valid signature is accepted', true, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, $vector, $secret, $now));
wpj_assert('a valid signature is accepted up to the second it expires', true, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, $vector, $secret, $exp));
wpj_assert('a wrong signature is refused', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, str_repeat('0', 64), $secret, $now));
wpj_assert('an empty signature is refused', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, '', $secret, $now));
wpj_assert('a signature made with another secret is refused', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, wpj_render_signature('wpj_render', '[wpj_fixture]', (string) $exp, 'another-secret-entirely-0123456789'), $secret, $now));
wpj_assert('an expired exp is refused', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, $vector, $secret, $exp + 1));
$far = (string) ($now + 601);
wpj_assert('an exp more than 600 s in the future is refused, even correctly signed', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', $far, wpj_render_signature('wpj_render', '[wpj_fixture]', $far, $secret), $secret, $now));
$edge = (string) ($now + 600);
wpj_assert('an exp exactly 600 s ahead is accepted', true, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', $edge, wpj_render_signature('wpj_render', '[wpj_fixture]', $edge, $secret), $secret, $now));
foreach (array('1700000300.0', '1e9', ' 1700000300', '1700000300 ', '-1', '', 'abc', "1700000300\n") as $bad) {
    wpj_assert('a non-integer exp ' . var_export($bad, true) . ' is refused, even correctly signed', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', $bad, wpj_render_signature('wpj_render', '[wpj_fixture]', $bad, $secret), $secret, $now));
}
wpj_assert('an array exp is refused rather than cast into a warning', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', array('1'), $vector, $secret, $now));
wpj_assert('an array signature is refused rather than cast into a warning', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, array($vector), $secret, $now));
wpj_assert('an array payload is refused', false, wpj_render_signature_valid('wpj_render', array('[wpj_fixture]'), (string) $exp, $vector, $secret, $now));
wpj_assert('a signature taken from a different payload is refused', false, wpj_render_signature_valid('wpj_render', '[other]', (string) $exp, $vector, $secret, $now));
wpj_assert('a signature taken from the other door is refused', false, wpj_render_signature_valid('wpj_render_block', '[wpj_fixture]', (string) $exp, $vector, $secret, $now));
$block = wpj_render_signature('wpj_render_block', 'wpj-fixture/dynamic', (string) $exp, $secret);
wpj_assert('the block door accepts its own signature', true, wpj_render_signature_valid('wpj_render_block', 'wpj-fixture/dynamic', (string) $exp, $block, $secret, $now));
wpj_assert('the shortcode door refuses a block signature', false, wpj_render_signature_valid('wpj_render', 'wpj-fixture/dynamic', (string) $exp, $block, $secret, $now));
wpj_assert('a short secret signs nothing', false, wpj_render_signature_valid('wpj_render', '[wpj_fixture]', (string) $exp, wpj_render_signature('wpj_render', '[wpj_fixture]', (string) $exp, 'short'), 'short', $now));

wpj_assert_exit();
