import {
  $isRootNode,
  $isParagraphNode,
  LexicalNode,
  RootNode as LexicalRootNode,
  ElementNode as LexicalElementNode,
  $createParagraphNode,
  $createTextNode,
  $isTextNode,
  TextNode,
  ParagraphNode,
  $isElementNode,
  ElementNode,
} from 'lexical'
import * as Mdast from 'mdast'
import { toMarkdown } from 'mdast-util-to-markdown'
import { mdxFromMarkdown, MdxJsxTextElement, mdxToMarkdown } from 'mdast-util-mdx'
import { mdxjs } from 'micromark-extension-mdxjs'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { IS_BOLD, IS_CODE, IS_ITALIC, IS_UNDERLINE } from './FormatConstants'
import { $createLinkNode, $isLinkNode, LinkNode } from '@lexical/link'
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createCodeNode, $isCodeNode, CodeNode } from '@lexical/code'
import { HorizontalRuleNode, $createHorizontalRuleNode, $isHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { $createImageNode, $isImageNode, ImageNode } from './nodes/ImageNode'

type MdastNode = Mdast.Content

interface LexicalVisitActions<T extends LexicalNode> {
  visitChildren(node: T, mdastParent: Mdast.Parent): void
  addAndStepInto(type: string, props?: Record<string, unknown>, hasChildren?: boolean): void
  appendToParent<T extends Mdast.Parent>(parentNode: T, node: T['children'][number]): T['children'][number] | Mdast.Root
}

interface MdastVisitActions {
  visitChildren(node: Mdast.Parent, lexicalParent: LexicalNode): void
  addAndStepInto(lexicalNode: LexicalNode): void
  addFormatting(format: typeof IS_BOLD | typeof IS_ITALIC | typeof IS_UNDERLINE): void
  getParentFormatting(): number
}

interface MdastVisitParams<T extends MdastNode> {
  mdastNode: T
  lexicalParent: LexicalNode
  actions: MdastVisitActions
}

interface LexicalNodeVisitParams<T extends LexicalNode> {
  lexicalNode: T
  mdastParent: Mdast.Parent
  actions: LexicalVisitActions<T>
}

interface MarkdownImportExportVisitor<LN extends LexicalNode, UN extends MdastNode> {
  testMdastNode: ((mdastNode: MdastNode | Mdast.Root) => boolean) | string
  visitMdastNode(params: MdastVisitParams<UN>): void

  testLexicalNode?(lexicalNode: LexicalNode): lexicalNode is LN
  visitLexicalNode?(params: LexicalNodeVisitParams<LN>): void

  shouldJoin?(prevNode: Mdast.Content, currentNode: UN): boolean
  join?<T extends Mdast.Content>(prevNode: T, currentNode: T): T
}

const RootVisitor: MarkdownImportExportVisitor<LexicalRootNode, Mdast.Content> = {
  testMdastNode: 'root',
  visitMdastNode({ actions, mdastNode, lexicalParent }) {
    actions.visitChildren(mdastNode as unknown as Mdast.Root, lexicalParent)
  },

  testLexicalNode: $isRootNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto('root')
  },
}

const ParagraphVisitor: MarkdownImportExportVisitor<ParagraphNode, Mdast.Paragraph> = {
  testMdastNode: 'paragraph',
  visitMdastNode: function ({ mdastNode, lexicalParent, actions }): void {
    // markdown inserts paragraphs in lists. lexical does not.
    if ($isListItemNode(lexicalParent) || $isQuoteNode(lexicalParent)) {
      actions.visitChildren(mdastNode, lexicalParent)
    } else {
      actions.addAndStepInto($createParagraphNode())
    }
  },

  testLexicalNode: $isParagraphNode,
  visitLexicalNode: ({ actions }) => {
    actions.addAndStepInto('paragraph')
  },
}

const LinkVisitor: MarkdownImportExportVisitor<LinkNode, Mdast.Link> = {
  testMdastNode: 'link',
  visitMdastNode({ mdastNode, actions }) {
    actions.addAndStepInto($createLinkNode(mdastNode.url))
  },

  testLexicalNode: $isLinkNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    actions.addAndStepInto('link', { url: lexicalNode.getURL() })
  },
}

const HeadingVisitor: MarkdownImportExportVisitor<HeadingNode, Mdast.Heading> = {
  testMdastNode: 'heading',
  visitMdastNode: function ({ mdastNode, actions }): void {
    actions.addAndStepInto($createHeadingNode(`h${mdastNode.depth}`))
  },

  testLexicalNode: $isHeadingNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    const depth = parseInt(lexicalNode.getTag()[1], 10) as Mdast.Heading['depth']
    actions.addAndStepInto('heading', { depth })
  },
}

const ListVisitor: MarkdownImportExportVisitor<ListNode, Mdast.List> = {
  testMdastNode: 'list',
  visitMdastNode: function ({ mdastNode, lexicalParent, actions }): void {
    const lexicalNode = $createListNode(mdastNode.ordered ? 'number' : 'bullet')

    if ($isListItemNode(lexicalParent)) {
      const dedicatedParent = $createListItemNode()
      dedicatedParent.append(lexicalNode)
      lexicalParent.insertAfter(dedicatedParent)
    } else {
      ;(lexicalParent as ElementNode).append(lexicalNode)
    }

    actions.visitChildren(mdastNode, lexicalNode)
  },

  testLexicalNode: $isListNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    actions.addAndStepInto('list', {
      ordered: lexicalNode.getListType() === 'number',
      //TODO: figure out when spread can be true
      spread: false,
    })
  },
}

// use Parent interface since we construct a list item to a paragraph :)
const ListItemVisitor: MarkdownImportExportVisitor<ListItemNode, Mdast.ListItem> = {
  testMdastNode: 'listItem',
  visitMdastNode: function ({ actions }): void {
    actions.addAndStepInto($createListItemNode())
  },

  testLexicalNode: $isListItemNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    const children = lexicalNode.getChildren()
    const firstChild = children[0]

    if (children.length === 1 && $isListNode(firstChild)) {
      // append the list ater the paragraph of the previous list item
      const prevListItemNode = mdastParent.children.at(-1) as Mdast.ListItem
      actions.visitChildren(lexicalNode, prevListItemNode)
    } else {
      // nest the children in a paragraph for MDAST compatibility
      const listItem = actions.appendToParent(mdastParent, {
        type: 'listItem' as const,
        spread: false,
        children: [{ type: 'paragraph' as const, children: [] }],
      }) as Mdast.ListItem
      actions.visitChildren(lexicalNode, listItem.children[0] as Mdast.Paragraph)
    }
  },
}

const BlockQuoteVisitor: MarkdownImportExportVisitor<QuoteNode, Mdast.Blockquote> = {
  testMdastNode: 'blockquote',
  visitMdastNode: ({ actions }) => {
    actions.addAndStepInto($createQuoteNode())
  },

  testLexicalNode: $isQuoteNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    const blockquote = actions.appendToParent(mdastParent, {
      type: 'blockquote' as const,
      children: [{ type: 'paragraph' as const, children: [] }],
    }) as Mdast.Blockquote
    actions.visitChildren(lexicalNode, blockquote.children[0] as Mdast.Paragraph)
  },
}

const FormattingVisitor: MarkdownImportExportVisitor<
  LexicalElementNode,
  Mdast.Paragraph | Mdast.Emphasis | Mdast.Strong | MdxJsxTextElement
> = {
  testMdastNode(mdastNode) {
    return (
      mdastNode.type === 'emphasis' || mdastNode.type === 'strong' || (mdastNode.type === 'mdxJsxTextElement' && mdastNode?.name === 'u')
    )
  },

  visitMdastNode: function ({ mdastNode, lexicalParent, actions }): void {
    if (mdastNode.type === 'emphasis') {
      actions.addFormatting(IS_ITALIC)
    } else if (mdastNode.type === 'strong') {
      actions.addFormatting(IS_BOLD)
    } else if (mdastNode.type === 'mdxJsxTextElement' && mdastNode.name === 'u') {
      actions.addFormatting(IS_UNDERLINE)
    }
    actions.visitChildren(mdastNode, lexicalParent)
  },
}

const InlineCodeVisitor: MarkdownImportExportVisitor<LexicalElementNode, Mdast.InlineCode> = {
  testMdastNode: 'inlineCode',
  visitMdastNode({ mdastNode, actions }) {
    actions.addAndStepInto($createTextNode(mdastNode.value).setFormat(IS_CODE))
  },
}

const CodeVisitor: MarkdownImportExportVisitor<CodeNode, Mdast.Code> = {
  testMdastNode: 'code',
  visitMdastNode({ mdastNode, actions }) {
    actions.addAndStepInto($createCodeNode(mdastNode.lang).append($createTextNode(mdastNode.value)))
  },

  testLexicalNode: $isCodeNode,
  visitLexicalNode: ({ lexicalNode, actions }) => {
    actions.addAndStepInto('code', {
      lang: lexicalNode.getLanguage(),
      value: lexicalNode.getTextContent(),
    })
  },
}

function isMdastText(mdastNode: Mdast.Content): mdastNode is Mdast.Text {
  return mdastNode.type === 'text'
}

const TextVisitor: MarkdownImportExportVisitor<TextNode, Mdast.Text> = {
  testMdastNode: 'text',
  visitMdastNode: function ({ mdastNode, actions }): void {
    actions.addAndStepInto($createTextNode(mdastNode.value).setFormat(actions.getParentFormatting()))
  },

  shouldJoin: (prevNode, currentNode) => {
    return ['text', 'emphasis', 'strong', 'mdxJsxTextElement'].includes(prevNode.type) && prevNode.type === currentNode.type
  },

  join<T extends Mdast.Content>(prevNode: T, currentNode: T) {
    if (isMdastText(prevNode) && isMdastText(currentNode)) {
      return {
        type: 'text',
        value: prevNode.value + currentNode.value,
      } as unknown as T
    } else {
      return {
        ...prevNode,
        children: [...(prevNode as unknown as Mdast.Parent).children, ...(currentNode as unknown as Mdast.Parent).children],
      }
    }
  },

  testLexicalNode: $isTextNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    const previousSibling = lexicalNode.getPreviousSibling()
    const prevFormat = $isTextNode(previousSibling) ? previousSibling.getFormat() : 0
    const format = lexicalNode.getFormat() ?? 0

    if (format & IS_CODE) {
      actions.addAndStepInto('inlineCode', {
        value: lexicalNode.getTextContent(),
      })
      return
    }

    let localParentNode = mdastParent

    if (prevFormat & format & IS_ITALIC) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'emphasis',
        children: [],
      }) as Mdast.Parent
    }
    if (prevFormat & format & IS_BOLD) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'strong',
        children: [],
      }) as Mdast.Parent
    }

    if (prevFormat & format & IS_UNDERLINE) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'u',
        children: [],
        attributes: [],
      }) as Mdast.Parent
    }

    if (format & IS_ITALIC && !(prevFormat & IS_ITALIC)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'emphasis',
        children: [],
      }) as Mdast.Parent
    }

    if (format & IS_BOLD && !(prevFormat & IS_BOLD)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'strong',
        children: [],
      }) as Mdast.Parent
    }

    if (format & IS_UNDERLINE && !(prevFormat & IS_UNDERLINE)) {
      localParentNode = actions.appendToParent(localParentNode, {
        type: 'mdxJsxTextElement',
        name: 'u',
        children: [],
        attributes: [],
      }) as Mdast.Parent
    }

    actions.appendToParent(localParentNode, {
      type: 'text',
      value: lexicalNode.getTextContent(),
    })
  },
}

const ThematicBreakVisitor: MarkdownImportExportVisitor<HorizontalRuleNode, Mdast.ThematicBreak> = {
  testMdastNode: 'thematicBreak',
  visitMdastNode({ actions }) {
    actions.addAndStepInto($createHorizontalRuleNode())
  },

  testLexicalNode: $isHorizontalRuleNode,
  visitLexicalNode({ actions }) {
    actions.addAndStepInto('thematicBreak')
  },
}

const ImageVisitor: MarkdownImportExportVisitor<ImageNode, Mdast.Image> = {
  testMdastNode: 'image',
  visitMdastNode({ mdastNode, actions }) {
    actions.addAndStepInto(
      $createImageNode({
        src: mdastNode.url,
        altText: mdastNode.alt || '',
        title: mdastNode.title || '',
      })
    )
  },

  testLexicalNode: $isImageNode,
  visitLexicalNode({ lexicalNode, actions }) {
    actions.addAndStepInto('image', {
      url: lexicalNode.getSrc(),
      alt: lexicalNode.getAltText(),
      title: lexicalNode.getTitle(),
    })
  },
}

export const VISITORS = [
  RootVisitor,
  ParagraphVisitor,
  TextVisitor,
  FormattingVisitor,
  InlineCodeVisitor,
  LinkVisitor,
  HeadingVisitor,
  ListVisitor,
  ListItemVisitor,
  BlockQuoteVisitor,
  CodeVisitor,
  ThematicBreakVisitor,
  ImageVisitor,
]

export type Visitors = Array<MarkdownImportExportVisitor<LexicalNode, Mdast.Content>>

function isParent(node: unknown): node is Mdast.Parent {
  return (node as { children?: Array<any> }).children instanceof Array
}

export function importMarkdownToLexical(root: LexicalRootNode, markdown: string, visitors: Visitors = VISITORS): void {
  const formattingMap = new WeakMap<object, number>()

  const tree = fromMarkdown(markdown, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  })

  function visitChildren(mdastNode: Mdast.Parent, lexicalParent: LexicalNode) {
    if (!isParent(mdastNode)) {
      throw new Error('Attempting to visit children of a non-parent')
    }
    mdastNode.children.forEach((child) => visit(child, lexicalParent, mdastNode))
  }

  function visit(mdastNode: Mdast.Content | Mdast.Root, lexicalParent: LexicalNode, mdastParent: Mdast.Parent | null) {
    const visitor = visitors.find((visitor) => {
      if (typeof visitor.testMdastNode === 'string') {
        return visitor.testMdastNode === mdastNode.type
      }
      return visitor.testMdastNode(mdastNode)
    })
    if (!visitor) {
      throw new Error(`no unist visitor found for ${mdastNode.type}`, {
        cause: mdastNode,
      })
    }

    visitor.visitMdastNode({
      //@ts-expect-error root type is glitching
      mdastNode,
      lexicalParent,
      actions: {
        visitChildren,
        addAndStepInto(lexicalNode) {
          ;(lexicalParent as ElementNode).append(lexicalNode)
          if (isParent(mdastNode)) {
            visitChildren(mdastNode, lexicalNode)
          }
        },
        addFormatting(format) {
          formattingMap.set(mdastNode, format | (formattingMap.get(mdastParent!) ?? 0))
        },
        getParentFormatting() {
          return formattingMap.get(mdastParent!) ?? 0
        },
      },
    })
  }

  visit(tree, root, null)
}

function traverseLexicalTree(root: LexicalRootNode, visitors: Visitors): Mdast.Root {
  let unistRoot: Mdast.Root | null = null
  visit(root, null)

  function appendToParent<T extends Mdast.Parent, C extends Mdast.Content>(parentNode: T, node: C): C | Mdast.Root {
    if (unistRoot === null) {
      unistRoot = node as unknown as Mdast.Root
      return unistRoot
    }

    if (!isParent(parentNode)) {
      throw new Error('Attempting to append children to a non-parent')
    }

    const siblings = parentNode.children
    const prevSibling = siblings.at(-1)

    if (prevSibling) {
      const joinVisitor = visitors.find((visitor) => visitor.shouldJoin?.(prevSibling, node))
      if (joinVisitor) {
        const joinedNode = joinVisitor.join!(prevSibling, node) as C
        siblings.splice(siblings.length - 1, 1, joinedNode)
        return joinedNode
      }
    }

    siblings.push(node)
    return node
  }

  function visitChildren(lexicalNode: LexicalElementNode, parentNode: Mdast.Parent) {
    lexicalNode.getChildren().forEach((lexicalChild) => {
      visit(lexicalChild, parentNode)
    })
  }

  function visit(lexicalNode: LexicalNode, mdastParent: Mdast.Parent | null) {
    const visitor = visitors.find((visitor) => visitor.testLexicalNode?.(lexicalNode))
    if (!visitor) {
      throw new Error(`no lexical visitor found for ${lexicalNode.getType()}`, {
        cause: lexicalNode,
      })
    }

    visitor.visitLexicalNode?.({
      lexicalNode,
      mdastParent: mdastParent!,
      actions: {
        addAndStepInto(type: string, props = {}, hasChildren = true) {
          const newNode = {
            type,
            ...props,
            ...(hasChildren ? { children: [] } : {}),
          }
          appendToParent(mdastParent!, newNode as unknown as Mdast.Content)
          if ($isElementNode(lexicalNode) && hasChildren) {
            visitChildren(lexicalNode, newNode as Mdast.Parent)
          }
        },
        appendToParent,
        visitChildren,
      },
    })
  }

  if (unistRoot === null) {
    throw new Error('traversal ended with no root element')
  }
  return unistRoot
}

export function exportMarkdownFromLexical(root: LexicalRootNode, visitors: Visitors = VISITORS): string {
  return toMarkdown(traverseLexicalTree(root, visitors), {
    extensions: [mdxToMarkdown()],
    listItemIndent: 'one',
  })
}
